import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * Recurring and linked jobs, end to end — spec 6.3.
 *
 * The arithmetic is proven in `lib/recurrence.test.ts` and the data layer in
 * `lib/series.integration.test.ts`. What only a browser can show is that the
 * recurrence fields reach the server at all: they are a collapsed section of
 * checkboxes and radios on a form that submits through a Server Action, and
 * the failure mode is silent — the operator ticks "repeats", books, and gets
 * one job without being told why.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

const RUN = uniqueDigits(6);

/**
 * A booked job's URL.
 *
 * The negative lookahead matters: `/jobs/new` also matches `/jobs/<anything>`,
 * so a looser pattern resolves against the form the click was made from and
 * the assertions that follow read the booking form instead of the job.
 */
const BOOKED_JOB_URL = /\/jobs\/(?!new$|series)[^/]+$/;

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

test.describe.configure({ mode: 'serial' });

test.describe('recurring and linked jobs', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  const pickup = `Recurring Pickup ${RUN}`;
  let seriesUrl = '';
  let outboundUrl = '';

  test('books a series and lands on it', async ({ page }) => {
    await signIn(page);
    await page.goto('/jobs/new');

    await page.getByLabel('Date').fill(dateIn(10));
    await page.getByLabel('Time').fill('09:00');
    await page.getByLabel('Pickup').fill(pickup);
    await page.getByLabel('Destination').fill('Heathrow Terminal 5');
    await page.getByLabel('Client price').fill('125.50');

    // The section is collapsed until ticked, which is the behaviour worth
    // proving as much as the booking itself.
    await expect(page.getByTestId('repeat-fields')).toBeVisible();
    await page.getByTestId('repeats-toggle').check();

    await page.locator('select[name="repeatFrequency"]').selectOption('DAILY');
    await page.locator('input[name="repeatCount"]').fill('4');

    await Promise.all([
      page.waitForURL(/\/jobs\/series\/[^/]+$/, { timeout: 60_000 }),
      page.getByRole('button', { name: 'Book job' }).click(),
    ]);

    seriesUrl = page.url();

    // Four jobs, each its own row with its own reference.
    await expect(page.getByTestId('series-job')).toHaveCount(4);
  });

  test('every occurrence is a real job of its own', async ({ page }) => {
    // Spec 6.3.4. Opening one has to give an ordinary job, not a view of a
    // rule — that is the whole design of the series.
    await signIn(page);
    await page.goto(seriesUrl);

    const first = page.getByTestId('series-job').first();
    await first.getByRole('link').first().click();

    await expect(page.getByTestId('job-status')).toBeVisible();
    // And it says where it came from.
    await expect(page.getByTestId('job-links')).toContainText(/recurring series/i);
    outboundUrl = page.url();
  });

  test('offers the reach when editing a job from a series', async ({ page }) => {
    // Spec 6.3.5. "This job only" is the default.
    await signIn(page);
    await page.goto(`${outboundUrl}/edit`);

    const scope = page.getByTestId('series-scope-field');
    await expect(scope).toBeVisible();
    await expect(scope.locator('select[name="seriesScope"]')).toHaveValue('this');
  });

  test('cancels this and future without touching the rest', async ({ page }) => {
    // Spec 6.3.6.
    await signIn(page);
    await page.goto(seriesUrl);

    await page.getByTestId('series-scope').selectOption('future');
    await Promise.all([
      page.waitForURL(/cancelled=/, { timeout: 60_000 }),
      page.getByRole('button', { name: 'Cancel jobs' }).click(),
    ]);

    await expect(page.getByTestId('series-message')).toBeVisible();
    // All four were ahead, so all four go.
    await expect(
      page.getByTestId('series-job').filter({ hasText: 'CANCELLED' }),
    ).toHaveCount(4);
  });

  test('a return journey links both ways', async ({ page }) => {
    // Spec 6.3.1 and 6.3.2.
    await signIn(page);

    // A fresh one-off, so the series cancellations above are irrelevant.
    await page.goto('/jobs/new');
    await page.getByLabel('Date').fill(dateIn(12));
    await page.getByLabel('Time').fill('09:00');
    await page.getByLabel('Pickup').fill(`Outbound ${RUN}`);
    await page.getByLabel('Destination').fill('Heathrow Terminal 5');
    await page.getByLabel('Client price').fill('125.50');
    await Promise.all([
      page.waitForURL(BOOKED_JOB_URL, { timeout: 60_000 }),
      page.getByRole('button', { name: 'Book job' }).click(),
    ]);

    const outbound = page.url();
    const outboundRef = await page.getByRole('heading').first().innerText();

    await page.getByRole('link', { name: 'Return journey' }).click();

    // The route is swapped and a time is suggested rather than left blank.
    await expect(page.getByLabel('Pickup')).toHaveValue('Heathrow Terminal 5');
    await expect(page.getByLabel('Destination')).toHaveValue(`Outbound ${RUN}`);
    await expect(page.getByLabel('Date')).not.toHaveValue('');
    await expect(page.getByLabel('Time')).not.toHaveValue('');

    await Promise.all([
      page.waitForURL(BOOKED_JOB_URL, { timeout: 60_000 }),
      page.getByRole('button', { name: 'Book job' }).click(),
    ]);

    // From the return, the outbound is named.
    await expect(page.getByTestId('job-links')).toContainText(outboundRef.trim());

    // And from the outbound, the return is.
    await page.goto(outbound);
    await expect(page.getByTestId('job-links')).toContainText(/Returns as/i);
  });

  test('lists the series on its own screen', async ({ page }) => {
    // Spec 6.3.7.
    await signIn(page);
    await page.goto('/jobs/series?all=true');

    await expect(page.getByTestId('series-table')).toBeVisible();
    await expect(
      page.getByTestId('series-row').filter({ hasText: pickup }),
    ).toBeVisible();
  });
});
