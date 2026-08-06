import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * The bulk action bar, end to end — spec 6.5.
 *
 * This suite exists because the bar was broken and nothing noticed. As Server
 * Actions the bulk actions applied their changes, called `revalidatePath` on
 * the list they were posted from, and had their response aborted by the
 * router's refetch — so the result never arrived and the button sat on
 * "Working…" indefinitely, over jobs that had in fact been updated.
 *
 * Every unit and integration test passed throughout, because the failure was
 * entirely in the round trip. Only a browser can see it, which is why these
 * assertions are on the *message coming back*, not just on the data.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

const RUN = uniqueDigits(6);

function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** A job with no price, so bulk pricing has something to do. */
async function unpricedJob(page: Page, pickup: string) {
  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(dateIn(20));
  await page.getByLabel('Time').fill('11:00');
  await page.getByLabel('Pickup').fill(pickup);
  await page.getByLabel('Destination').fill('Heathrow Terminal 5');
  // Booking without a price takes a deliberate second click — the submit
  // button stays disabled until the warning is acknowledged.
  await expect(page.getByTestId('unpriced-warning')).toBeVisible();
  await page.getByRole('button', { name: 'Save without a price' }).click();
  await page.getByRole('button', { name: 'Book job' }).click();
  await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('bulk actions', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  const pickup = `Bulk Pickup ${RUN}`;

  test('prices several jobs at once and says what it did', async ({ page }) => {
    await signIn(page);
    for (let i = 0; i < 3; i += 1) await unpricedJob(page, `${pickup} ${i}`);

    await page.goto(`/jobs?all=true&q=${encodeURIComponent(pickup)}`);
    await page.waitForLoadState('networkidle');

    const boxes = page.locator('tbody input[type="checkbox"]');
    await expect(boxes).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) await boxes.nth(i).check();

    await expect(page.getByTestId('bulk-count')).toContainText('3 selected');

    const mode = page.locator('#bulk-mode');
    if ((await mode.count()) > 0) await mode.selectOption('price');
    await page.locator('#bulk-client-price').fill('99.00');

    // The assertion that matters. The button used to never come back.
    await Promise.all([
      page.waitForURL(/bulkMessage|bulkError/, { timeout: 30_000 }),
      page.getByRole('button', { name: /Price 3 jobs/ }).click(),
    ]);

    await expect(page.getByTestId('bulk-result')).toContainText('3 jobs updated');
  });

  test('the prices actually landed', async ({ page }) => {
    await signIn(page);
    await page.goto(`/jobs?all=true&q=${encodeURIComponent(pickup)}`);

    // No "No price" badges left on these three.
    await expect(page.getByText('No price')).toHaveCount(0);
  });

  test('keeps the filters it was working in', async ({ page }) => {
    // Landing back at the top of an unfiltered list loses the operator's
    // place, which on a job list is most of the work.
    await signIn(page);
    await page.goto(`/jobs?all=true&q=${encodeURIComponent(pickup)}`);
    await page.waitForLoadState('networkidle');

    await page.locator('tbody input[type="checkbox"]').first().check();
    const mode = page.locator('#bulk-mode');
    if ((await mode.count()) > 0) await mode.selectOption('status');
    await page.locator('#bulk-status').selectOption('CANCELLED');

    await Promise.all([
      page.waitForURL(/bulkMessage|bulkError/, { timeout: 30_000 }),
      page.getByRole('button', { name: /Update 1 job/ }).click(),
    ]);

    // `URLSearchParams` encodes a space as `+`, not `%20` — both are valid
    // form encoding and Next decodes either, so the assertion is on the
    // filter surviving rather than on how it was spelled.
    const back = new URL(page.url());
    expect(back.searchParams.get('q')).toBe(pickup);
    expect(back.searchParams.get('all')).toBe('true');
  });

  test('names the jobs it refused rather than counting them', async ({ page }) => {
    // Spec 6.5.3. "One refused" tells the operator there is a problem without
    // telling them where it is.
    await signIn(page);
    await page.goto(`/jobs?all=true&q=${encodeURIComponent(pickup)}`);
    await page.waitForLoadState('networkidle');

    // The one just cancelled cannot move to IN_PROGRESS.
    const boxes = page.locator('tbody input[type="checkbox"]');
    const count = await boxes.count();
    for (let i = 0; i < count; i += 1) await boxes.nth(i).check();

    const mode = page.locator('#bulk-mode');
    if ((await mode.count()) > 0) await mode.selectOption('status');
    await page.locator('#bulk-status').selectOption('IN_PROGRESS');

    await Promise.all([
      page.waitForURL(/bulkMessage|bulkError/, { timeout: 30_000 }),
      page.getByRole('button', { name: /Update \d+ jobs?/ }).click(),
    ]);

    const result = page.getByTestId('bulk-result');
    await expect(result).toContainText(/refused/i);
    // By reference, so somebody can go and look at it.
    await expect(result).toContainText(/[A-Z]+-\d+/);
  });
});
