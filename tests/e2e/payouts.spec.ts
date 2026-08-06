import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4.5 acceptance, end to end.
 *
 * The walk the spec's definition of done names: generate a payout, approve
 * it, mark it paid, and confirm every job it covered reads as fully paid.
 * That last step is the point — a payout marked paid with its jobs still
 * showing unpaid is unresolvable afterwards, because nobody can tell whether
 * the money went out.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

async function selectByOptionText(page: Page, selectId: string, text: string) {
  const select = page.locator(selectId);
  const value = await select
    .locator('option', { hasText: text })
    .first()
    .getAttribute('value');
  expect(value, `no option matching ${text} in ${selectId}`).toBeTruthy();
  await select.selectOption(value!);
}

async function submitStatus(page: Page, label: string) {
  const before = page.url();
  await page.locator('#status').selectOption({ label });
  await Promise.all([
    page.waitForURL((url) => url.toString() !== before, { timeout: 15_000 }),
    page.getByRole('button', { name: 'Update status' }).click(),
  ]);
}

test.describe('payouts', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('a payout is generated, approved, paid, and flips its jobs', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const stamp = String(Date.now()).slice(-6);
    const driverName = `Payout Driver ${stamp}`;
    const plate = `PO${stamp.slice(-5)}`;

    await page.goto('/vehicles/new');
    await page.getByLabel('Registration').fill(plate);
    await page.getByLabel('Make').fill('Mercedes-Benz');
    await page.getByLabel('Model').fill('E-Class');
    await page.getByLabel('MOT expires').fill(dateIn(400));
    await page.getByLabel('Insurance expires').fill(dateIn(400));
    await page.getByLabel('PHV vehicle licence expires').fill(dateIn(400));
    await page.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(page.getByRole('heading', { name: plate })).toBeVisible();

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(driverName);
    await page.getByLabel('Phone').fill(`0770092${stamp.slice(-4)}`);
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(400));
    await selectByOptionText(page, '#assignedVehicleId', plate);
    await page.getByRole('button', { name: 'Add driver' }).click();
    await expect(page.getByRole('heading', { name: driverName })).toBeVisible();

    // A completed job, dated inside the period the payout will cover.
    await page.goto('/jobs/new');
    await page.getByLabel('Date').fill(dateIn(-3));
    await page.getByLabel('Time').fill('08:00');
    await page.getByLabel('Pickup').fill(`Belgravia ${stamp}`);
    await page.getByLabel('Destination').fill('Gatwick South Terminal');
    await page.getByLabel('Client price').fill('180.00');
    await page.getByLabel('Driver price').fill('120.00');
    await selectByOptionText(page, '#driverId', driverName);
    await page.getByRole('button', { name: 'Book job' }).click();
    // Waited on the job's own status control, not on the absence of a
    // warning: `toHaveCount(0)` passes on any page, including the booking
    // form the browser has not left yet.
    try {
      await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 15_000 });
    } catch {
      const messages = await page.locator('[role="alert"], .text-destructive').allInnerTexts();
      throw new Error(
        `Booking did not land. url=${page.url()} messages=${JSON.stringify(messages)}`,
      );
    }
    await expect(page.getByTestId('unpriced-alert')).toHaveCount(0);

    for (const status of ['Assigned', 'In progress', 'Completed']) {
      await submitStatus(page, status);
    }
    await expect(page.getByTestId('job-status')).toHaveText('Completed', {
      timeout: 15_000,
    });

    // Captured here rather than straight after booking: the assertion above
    // is what proves the browser has actually landed on the job, and reading
    // the URL any earlier can still return `/jobs/new`.
    const jobUrl = page.url().split('?')[0]!;

    // 4.5.1 — generate over a period wide enough to hold it.
    await page.goto(`/payouts/new?from=${dateIn(-14)}&to=${dateIn(0)}`);
    const driverCard = page
      .locator('[data-testid^="draft-"]')
      .filter({ hasText: driverName });
    await expect(driverCard).toBeVisible();
    await expect(driverCard).toContainText('£120.00');

    await driverCard.getByRole('button', { name: 'Draft it' }).click();
    await expect(page).toHaveURL(/\/payouts\/[^/?]+\?/);
    await expect(page.getByText('£120.00').first()).toBeVisible();

    const payoutUrl = page.url().split('?')[0]!;

    // 4.5.5 — the statement names the driver, the period and each line.
    const statement = await page.evaluate(async (url) => {
      const response = await fetch(
        `${url}/document`.replace('/payouts/', '/api/payouts/'),
      );
      return { status: response.status, body: await response.text() };
    }, payoutUrl);
    expect(statement.status).toBe(200);
    expect(statement.body).toContain('Driver statement');
    expect(statement.body).toContain(driverName);
    expect(statement.body).toContain('Not yet paid');

    // Paying is refused before approval — the two are kept apart on purpose.
    const early = await page.evaluate(async (url) => {
      const response = await fetch(
        `${url}/actions`.replace('/payouts/', '/api/payouts/'),
        { method: 'POST', body: new URLSearchParams({ intent: 'pay' }) },
      );
      return response.url;
    }, payoutUrl);
    expect(new URL(early).searchParams.get('payoutError')).toContain(
      'Approve it first',
    );

    await page.goto(payoutUrl);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('pay-form')).toBeVisible();

    // 4.5.3 — approve, pay, and every covered job flips in one go.
    await page.getByTestId('pay-form').getByRole('textbox').last().fill('FPS-E2E');
    await page.getByTestId('pay-form').getByRole('button', { name: 'Mark paid' }).click();
    await expect(page.getByTestId('payout-settled')).toBeVisible();

    // The pay status is a select on the finance panel, so its *value* is the
    // assertion — the words are in an option either way.
    await page.goto(`${jobUrl}/finance`);
    await expect(page.locator('#driverPayStatus')).toHaveValue('FULLY_PAID');

    // The statement now says so too, rather than reading the same before and
    // after the money moved.
    const settled = await page.evaluate(async (url) => {
      const response = await fetch(
        `${url}/document`.replace('/payouts/', '/api/payouts/'),
      );
      return response.text();
    }, payoutUrl);
    expect(settled).toContain('FPS-E2E');
    expect(settled).not.toContain('Not yet paid');

    // 4.5.4 — the job cannot land on a second payout.
    await page.goto(`/payouts/new?from=${dateIn(-14)}&to=${dateIn(0)}`);
    const again = page
      .locator('[data-testid^="draft-"]')
      .filter({ hasText: driverName });
    if ((await again.count()) > 0) {
      await expect(again).toContainText('Already on another payout');
      await expect(again.getByRole('button', { name: 'Draft it' })).toHaveCount(0);
    }
  });
});
