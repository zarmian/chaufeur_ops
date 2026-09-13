import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits, uniquePhone, uniquePlate } from './unique';

/**
 * Changing the car on a standing contract.
 *
 * A contract is an arrangement, and the days it has already booked are
 * ordinary jobs — which is why nothing else in the contract screen reaches
 * forward into them. Moving the car is the exception, and it earns it: a
 * contract whose car changes permanently, with a fortnight of days already
 * booked against the old one, otherwise means a fortnight of jobs reassigned
 * by hand, and the day somebody misses is a client watching the road for a
 * registration that is not coming.
 *
 * The decisions are unit-tested in `lib/contracts.test.ts` and the database
 * behaviour in `lib/contracts.integration.test.ts`. What only a browser shows
 * is whether the box is wired to any of it — whether it is on by default,
 * whether it posts, and whether what happened is actually said back to the
 * operator. That is where the equivalent address bug lived.
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

async function addVehicle(page: Page, expiresInDays: number): Promise<string> {
  const plate = uniquePlate('CT');

  await page.goto('/vehicles/new');
  await page.getByLabel('Registration').fill(plate);
  await page.getByLabel('Make').fill('Mercedes-Benz');
  await page.getByLabel('Model').fill('E-Class');
  await page.getByLabel('MOT expires').fill(dateIn(expiresInDays));
  await page.getByLabel('Insurance expires').fill(dateIn(expiresInDays));
  await page.getByLabel('PHV vehicle licence expires').fill(dateIn(expiresInDays));
  await page.getByRole('button', { name: 'Add vehicle' }).click();
  await expect(page.getByRole('heading', { name: plate })).toBeVisible();

  return plate;
}

/** Pick the option whose text contains `text`, by select id. */
async function selectByOptionText(page: Page, selectId: string, text: string) {
  const select = page.locator(selectId);
  const value = await select
    .locator('option', { hasText: text })
    .first()
    .getAttribute('value');
  expect(value, `no option matching ${text} in ${selectId}`).toBeTruthy();
  await select.selectOption(value!);
}

test.describe('changing the car on a contract', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  // One dispatcher, one contract, worked through in order.
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let oldCar = '';
  let newCar = '';
  let contractUrl = '';

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);

    oldCar = await addVehicle(page, 400);
    newCar = await addVehicle(page, 400);

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(`Contract Driver ${RUN}`);
    await page.getByLabel('Phone').fill(uniquePhone());
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(400));
    await page.getByRole('button', { name: 'Add driver' }).click();
    await expect(
      page.getByRole('heading', { name: `Contract Driver ${RUN}` }),
    ).toBeVisible();
  });

  test.afterAll(async () => {
    await page.close();
  });

  /** Open the earliest day the contract booked, to read the car off the job. */
  async function openFirstDay() {
    await page.goto(contractUrl);
    await page.locator('table tbody tr a').first().click();
    await expect(page).toHaveURL(/\/jobs\//);
  }

  test('books a fortnight of days against the car it was given', async () => {
    await page.goto('/contracts/new');

    await page.locator('#label').fill(`School run ${RUN}`);
    await page.locator('#clientId').selectOption({ index: 1 });
    await page.locator('#pickupText').fill('21 York Terrace East');
    await page.locator('#dropoffText').fill('Highgate School');
    await page.locator('#startTime').fill('07:45');
    await page.locator('#startsOn').fill(dateIn(1));
    await page.locator('#dayRate').fill('120.00');
    await page.locator('#driverDayRate').fill('55.00');
    await selectByOptionText(page, '#driverId', `Contract Driver ${RUN}`);
    await selectByOptionText(page, '#vehicleId', oldCar);

    await page.getByRole('button', { name: 'Start the contract' }).click();
    await expect(page.getByRole('heading', { name: `School run ${RUN}` })).toBeVisible();

    contractUrl = page.url().split('?')[0]!;
    // The days are booked on creation rather than left until the cron runs, so
    // there is something to move by the time the next test edits the contract.
    await expect(page.getByText(oldCar).first()).toBeVisible();
  });

  test('offers to move the days, and only once the car has changed', async () => {
    await page.goto(`${contractUrl}/edit`);
    const move = page.getByRole('checkbox', {
      name: /Move the days not yet started/,
    });

    // On by default — this is a change to the arrangement, and the days
    // already booked against the old car are the point of the question.
    await expect(move).toBeChecked();
    // …and inert until there is something to move, so it cannot be ticked
    // while somebody is correcting the pickup address.
    await expect(move).toBeDisabled();

    await selectByOptionText(page, '#vehicleId', newCar);

    await expect(move).toBeEnabled();
    await expect(move).toBeChecked();
  });

  test('moves them, and says how many', async () => {
    await page.getByRole('button', { name: 'Save changes' }).click();

    const notice = page.getByTestId('contract-moved');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(/\d+ upcoming days? moved/);

    // The contract itself now names the new car…
    await expect(page.getByText(newCar).first()).toBeVisible();
    await expect(page.getByText(oldCar)).toHaveCount(0);

    // …and so does a day it booked before the change, which is the whole
    // claim. The days table does not show a car, so the job itself is opened.
    await openFirstDay();
    await expect(page.getByText(newCar).first()).toBeVisible();
  });

  test('leaves the days alone when the box is cleared', async () => {
    /*
     * The other half of the promise. An operator who unticks it is saying the
     * new car applies from here on — a contract moving cars next month, with
     * this month already crewed — and the days must not move.
     */
    await page.goto(`${contractUrl}/edit`);
    await selectByOptionText(page, '#vehicleId', oldCar);
    await page
      .getByRole('checkbox', { name: /Move the days not yet started/ })
      .uncheck();

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { name: `School run ${RUN}` })).toBeVisible();

    await expect(page.getByTestId('contract-moved')).toHaveCount(0);
    // The contract now says the old car…
    await expect(page.getByText(oldCar).first()).toBeVisible();

    // …and the day it had already booked still says the new one, which is
    // exactly what unticking the box asked for.
    await openFirstDay();
    await expect(page.getByText(newCar).first()).toBeVisible();
  });
});
