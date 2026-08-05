import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2.6 acceptance: what a car is actually making.
 *
 * The two walk-throughs the spec names. The first is the one the phase exists
 * for — an annual premium recorded once must not make the month it falls due
 * look like a disaster, so a £1,200 policy has to show as about £100 across a
 * month. The second proves the refusal is real: a driver's own car cannot
 * take a company cost, because recording one there would be wrong twice.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/** `YYYY-MM-DD`, N days from now — so the fixture never goes stale. */
function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Pence from a rendered `£1,234.56`, sign included. */
function pence(text: string): number {
  const negative = text.trim().startsWith('-');
  const digits = text.replace(/[^0-9.]/g, '');
  return Math.round(Number(digits) * 100) * (negative ? -1 : 1);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** A vehicle held as `ownership`, returning the URL of its detail page. */
async function addVehicle(
  page: Page,
  registration: string,
  ownership: string,
): Promise<string> {
  await page.goto('/vehicles/new');
  await page.getByLabel('Registration').fill(registration);
  await page.getByLabel('Make').fill('Mercedes-Benz');
  await page.getByLabel('Model').fill('E-Class');
  await page.getByLabel('MOT expires').fill(dateIn(300));
  await page.getByLabel('Insurance expires').fill(dateIn(300));
  await page.getByLabel('PHV vehicle licence expires').fill(dateIn(300));
  await page.getByLabel('Held as').selectOption(ownership);
  await page.getByRole('button', { name: 'Add vehicle' }).click();

  await expect(page.getByRole('heading', { name: registration })).toBeVisible();
  return page.url();
}

/**
 * Pick the option whose text contains `text`, by select id.
 *
 * Option labels carry generated references the test cannot predict, so it
 * matches on the part it knows and selects by value. Ids rather than labels,
 * because "Driver" also matches the "Driver price" field.
 */
async function selectByOptionText(page: Page, selectId: string, text: string) {
  const select = page.locator(selectId);
  const value = await select
    .locator('option', { hasText: text })
    .first()
    .getAttribute('value');
  expect(value, `no option matching ${text} in ${selectId}`).toBeTruthy();
  await select.selectOption(value!);
}

/** A driver whose documents are all in date, assigned to `plate`. */
async function createCompliantDriver(page: Page, name: string, plate: string) {
  await page.goto('/drivers/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Phone').fill(`0770090${String(Date.now()).slice(-4)}`);
  await page.getByLabel('DVLA licence expires').fill(dateIn(400));
  await page.getByLabel('PHV badge expires').fill(dateIn(400));
  await selectByOptionText(page, '#assignedVehicleId', plate);
  await page.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** A priced job on `plate`, so the car has something to show a margin on. */
async function bookJobOn(
  page: Page,
  driverName: string,
  clientPrice: string,
  driverPrice: string,
) {
  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(dateIn(3));
  await page.getByLabel('Time').fill('14:30');
  await page.getByLabel('Pickup').fill(`The Dorchester ${Date.now()}`);
  await page.getByLabel('Destination').fill('Heathrow T5');
  await selectByOptionText(page, '#driverId', driverName);
  await page.getByLabel('Client price').fill(clientPrice);
  await page.getByLabel('Driver price').fill(driverPrice);
  await page.getByRole('button', { name: 'Book job' }).click();
  // Not a URL pattern: `/jobs/new` matches `/jobs/<id>` too, so waiting on
  // one would return before the booking had been submitted at all, and the
  // profit view would then be asked about a job that did not exist yet.
  await expect(page.getByTestId('job-status')).toBeVisible();
}

test.describe('fleet', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('an annual premium accrues by the month, not all at once', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const registration = `FL${String(Date.now()).slice(-6)}`;
    const detailUrl = await addVehicle(page, registration, 'FINANCED');

    // A repair, dated inside the window.
    await page.getByTestId('cost-form').getByLabel('Kind').selectOption('REPAIR');
    await page.getByTestId('cost-form').getByLabel('Amount').fill('120.00');
    await page.getByTestId('cost-form').getByLabel('Date').fill(dateIn(-10));
    await page.getByTestId('cost-form').getByLabel('Supplier').fill('Local garage');
    await page.getByTestId('cost-form').getByRole('button', { name: 'Add' }).click();

    await expect(page.getByTestId('cost-list')).toContainText('Local garage');
    await expect(page.getByTestId('cost-list')).toContainText('£120.00');

    // And a £1,200 annual policy, running from a month ago.
    await page
      .getByTestId('standing-form')
      .getByLabel('Kind')
      .selectOption('INSURANCE');
    await page.getByTestId('standing-form').getByLabel('Name').fill('Fleet policy');
    await page.getByTestId('standing-form').getByLabel('Amount').fill('1200.00');
    await page.getByTestId('standing-form').getByLabel('Every (months)').fill('12');
    await page.getByTestId('standing-form').getByLabel('Starts').fill(dateIn(-40));
    await page
      .getByTestId('standing-form')
      .getByRole('button', { name: 'Add' })
      .click();

    await expect(page.getByTestId('standing-list')).toContainText('Fleet policy');

    // The month just gone. The whole point: about a twelfth of the premium,
    // nowhere near the £1,200 that was actually paid.
    await page.goto(`${detailUrl.split('?')[0]}?from=${dateIn(-30)}&to=${dateIn(-1)}`);

    const accrued = pence(
      (await page.getByTestId('pnl-standing').textContent()) ?? '',
    );
    expect(Math.abs(accrued)).toBeGreaterThan(8000);
    expect(Math.abs(accrued)).toBeLessThan(12000);

    // The car has no revenue, so the month is a loss of the premium plus the
    // repair — which is exactly the thing worth seeing.
    const profit = pence((await page.getByTestId('pnl-profit').textContent()) ?? '');
    expect(profit).toBeLessThan(0);
  });

  test('a driver-owned car shows its margin and refuses a cost', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const stamp = String(Date.now()).slice(-6);
    const registration = `DO${stamp}`;
    const detailUrl = await addVehicle(page, registration, 'DRIVER_OWNED');

    // No cost form at all, and the reason said plainly rather than a form
    // that silently refuses everything typed into it.
    await expect(page.getByTestId('costs-not-ours')).toBeVisible();
    await expect(page.getByTestId('cost-form')).toHaveCount(0);
    await expect(page.getByTestId('standing-form')).toHaveCount(0);

    // Give it a job, so what is measured is a real margin rather than the
    // "no activity" notice a car nobody has used would show.
    const driverName = `Owner Driver ${stamp}`;
    await createCompliantDriver(page, driverName, registration);
    await bookJobOn(page, driverName, '300.00', '200.00');

    // An explicit window: the default looks back twelve months, and a job
    // booked for next week is not in it. That is right for a profit view of a
    // period that has happened, so the test asks about the period it made.
    await page.goto(`${detailUrl}?from=${dateIn(-1)}&to=${dateIn(30)}`);

    // The margin, and named as one — a driver-owned car has no company costs
    // to net off, so calling it "profit" would claim more than it is.
    await expect(page.getByText('What this car earns us')).toBeVisible();
    await expect(page.getByTestId('pnl-no-costs')).toBeVisible();
    expect(
      pence((await page.getByTestId('pnl-profit').textContent()) ?? ''),
    ).toBe(10000);

    // Posting a cost directly is refused too — the panel hiding the form is a
    // courtesy, the refusal on the server is the control. Submitted from
    // inside the page so it carries the session the way a real post would.
    const vehicleId = detailUrl.split('/').pop()!.split('?')[0]!;
    const location = await page.evaluate(async (id) => {
      const body = new URLSearchParams({
        intent: 'cost',
        kind: 'REPAIR',
        amount: '120.00',
        incurredOn: new Date().toISOString().slice(0, 10),
      });
      // Followed rather than manual: an opaque redirect hides its Location
      // from the page, and the landing URL carries the refusal anyway.
      const response = await fetch(`/api/vehicles/${id}/costs`, {
        method: 'POST',
        body,
      });
      return response.url;
    }, vehicleId);
    expect(location).toContain('costError=');

    // And nothing was recorded against it.
    await page.goto(detailUrl);
    await expect(page.getByTestId('cost-list')).toHaveCount(0);
  });

  test('the fleet view ranks cars and marks the idle ones', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const registration = `FR${String(Date.now()).slice(-6)}`;
    await addVehicle(page, registration, 'OWNED');

    await page.goto('/fleet');
    await expect(page.getByRole('heading', { name: 'Fleet profit' })).toBeVisible();

    // A car added moments ago has done nothing, and says so rather than
    // showing a row of zeroes that reads like a loss.
    const row = page.getByRole('row').filter({ hasText: registration });
    await expect(row).toContainText('No activity');
    await expect(row).toContainText('Company owned');
  });
});
