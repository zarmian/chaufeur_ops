import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits, uniquePhone, uniquePlate } from './unique';

/**
 * Finding one driver in a list of nearly two hundred.
 *
 * The report was that the driver and vehicle pickers are "very long to go
 * through", which they are: one option per owner-driver, in a native select
 * that opens as a scroll. A search box above the select narrows it.
 *
 * **The rule that needs a browser is the one about the current selection.** A
 * native `<select>` whose selected `<option>` is removed from the DOM loses
 * its value and says nothing about it — so a dispatcher who picks a driver and
 * then types into the search would book a job with nobody on it, and the form
 * would look exactly as it did a moment before. The pure rule is covered in
 * `lib/option-filter.test.ts`; this checks it is actually wired to the field,
 * which is where the equivalent address bug lived.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/** Distinctive enough that the search cannot match anything else. */
const RUN = uniqueDigits(6);

/**
 * Enough drivers that a search box is worth showing.
 *
 * `worthFiltering` starts at eight and the seed provides five, so a few of our
 * own guarantee the threshold regardless of what else has run. More than the
 * threshold needs, deliberately: a filter that leaves one of two options is
 * not really filtering.
 */
const ADDED = 4;

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

async function createDriver(page: Page, name: string) {
  const plate = uniquePlate('SR');

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
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Phone').fill(uniquePhone());
  await page.getByLabel('DVLA licence expires').fill(dateIn(400));
  await page.getByLabel('PHV badge expires').fill(dateIn(400));
  await page.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test.describe('searching a long list of drivers', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  // One dispatcher, one browser, for the whole file: the drivers created in
  // the first test are what the rest search through.
  test.describe.configure({ mode: 'serial' });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);

    for (let index = 0; index < ADDED; index += 1) {
      await createDriver(page, `Zephyrine Marchetti ${RUN}-${index}`);
    }
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('offers a search once the list stops fitting in a glance', async () => {
    await page.goto('/jobs/new');

    await expect(page.getByLabel('Search drivers')).toBeVisible();
    await expect(
      page.getByLabel('Search by registration or model'),
    ).toBeVisible();

    // The search is not part of the booking. A stray `q=` in the posted form
    // would be a field the server has to know to ignore.
    await expect(page.getByLabel('Search drivers')).not.toHaveAttribute(
      'name',
      /.+/,
    );
  });

  test('narrows the list to what was typed, and says so', async () => {
    await page.goto('/jobs/new');
    const options = page.locator('#driverId option');
    const before = await options.count();

    await page.getByLabel('Search drivers').fill(`Marchetti ${RUN}`);

    // Our four, plus the always-present "Unassigned".
    await expect(options).toHaveCount(ADDED + 1);
    expect(before).toBeGreaterThan(ADDED + 1);

    // Said out loud, because a select holding four of two hundred options
    // looks like a system that has lost the rest.
    await expect(page.getByRole('status').first()).toHaveText(
      new RegExp(`Showing ${ADDED} of `),
    );
  });

  test('keeps the chosen driver when the search would exclude them', async () => {
    /*
     * The rule this file exists for. Typing a search that does not match the
     * driver already picked must not remove them from the DOM.
     */
    await page.goto('/jobs/new');
    const select = page.locator('#driverId');

    await page.getByLabel('Search drivers').fill(`Marchetti ${RUN}-0`);
    await expect(page.locator('#driverId option')).toHaveCount(2);

    const chosen = await select
      .locator('option')
      .nth(1)
      .getAttribute('value');
    await select.selectOption(chosen!);

    await page.getByLabel('Search drivers').fill('nothing will match this');

    // Still there, still selected — the option survives its own filter.
    await expect(select).toHaveValue(chosen!);
    await expect(select.locator(`option[value="${chosen}"]`)).toHaveCount(1);
    await expect(page.getByRole('status').first()).toHaveText(/Showing 1 of /);
  });

  test('does not submit the booking when Enter is pressed in the search', async () => {
    // A search box sits inside the booking form, and Enter in a text input
    // submits its form. Here that would book a half-filled job.
    await page.goto('/jobs/new');

    await page.getByLabel('Search drivers').fill('Marchetti');
    await page.getByLabel('Search drivers').press('Enter');

    await expect(page).toHaveURL(/\/jobs\/new/);
    await expect(page.getByRole('button', { name: 'Book job' })).toBeVisible();
  });
});
