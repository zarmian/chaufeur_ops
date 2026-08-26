import { expect, test, type Page } from '@playwright/test';
import { uniqueLetters, uniquePhone, uniquePlate } from './unique';

/**
 * The search box on the driver and vehicle lists, in a browser.
 *
 * There was no test of any kind over these searches, and a defect sat in the
 * driver list unnoticed: `phone contains normalisePhone(q)` turned a search
 * for a *name* into `contains: ''`, which is `LIKE '%%'` and matches every
 * row. The list came back with everything in it, looking untouched — which is
 * indistinguishable, to whoever is using it, from a search box wired to
 * nothing. It was reported as "the search bar is not working", which is
 * exactly right.
 *
 * `lib/list-search.integration.test.ts` pins the queries. This pins the part
 * only a browser can: that typing in the box and pressing Enter puts the term
 * in the URL and narrows what is on screen. Both halves have to hold — the
 * query was correct-looking and the form was fine; the two together were not.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/** All letters, because a term with digits does not exercise the defect. */
const NAME_TOKEN = `Zz${uniqueLetters(6)}`;
const PLATE = uniquePlate('SQ');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Type into the box and press Enter, the way an operator does. */
async function search(page: Page, term: string) {
  const box = page.locator('#q');
  await box.click();
  await box.fill(term);
  await box.press('Enter');
  await page.waitForLoadState('networkidle');
}

test.describe.configure({ mode: 'serial' });

test.describe('list search', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('a driver search by name narrows the list to the match', async ({ page }) => {
    await signIn(page);

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(`${NAME_TOKEN} Fixture`);
    await page.getByLabel('Phone').fill(uniquePhone());
    await page.getByRole('button', { name: /Add driver|Create|Save/ }).first().click();
    await page.waitForURL(/\/drivers(\/|\?|$)/, { timeout: 15_000 });

    await page.goto('/drivers');
    const before = await page.locator('tbody tr').count();
    expect(before, 'needs more than one driver for this to mean anything').toBeGreaterThan(1);

    await search(page, NAME_TOKEN);

    // The term reaches the server…
    expect(page.url()).toContain(`q=${NAME_TOKEN}`);
    // …and the list actually narrows. Before the fix this stayed at `before`,
    // because every driver matched the empty phone clause.
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(NAME_TOKEN);
  });

  test('a driver search matching nobody returns nobody', async ({ page }) => {
    // The other half of the same defect: "no matches" has to mean an empty
    // list, not the whole table.
    await signIn(page);
    await page.goto('/drivers');
    await search(page, 'Zzqxnobodyiscalledthis');

    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.getByText(/No drivers match those filters/i)).toBeVisible();
  });

  test('a vehicle search finds a plate typed as it is printed', async ({ page }) => {
    await signIn(page);

    await page.goto('/vehicles/new');
    await page.getByLabel('Registration').fill(PLATE);
    await page.getByLabel('Make').fill('Testmake');
    await page.getByLabel('Model').fill('Testmodel');
    await page.getByRole('button', { name: /Add vehicle|Create|Save/ }).first().click();
    await page.waitForURL(/\/vehicles(\/|\?|$)/, { timeout: 15_000 });

    await page.goto('/vehicles');
    // With a space in the middle, as it appears on the car itself. The stored
    // value has none, so this only works because the term is normalised.
    const spaced = `${PLATE.slice(0, 4)} ${PLATE.slice(4)}`;
    await search(page, spaced);

    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(PLATE);
  });

  test('the term stays in the box, so it can be refined', async ({ page }) => {
    await signIn(page);
    await page.goto('/drivers');
    await search(page, NAME_TOKEN);
    await expect(page.locator('#q')).toHaveValue(NAME_TOKEN);
  });
});
