import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * What the pickup box holds after somebody uses it.
 *
 * The report was "the pickup and dropoff only take postcodes — any address
 * pasted converts to a postcode". It was true, and it had two halves. Choosing
 * a suggestion overwrote the box with the provider's label, and on the default
 * provider the label *is* the postcode, so a pasted street address became a
 * bare postcode: the building, the street and the number gone, and gone from
 * the driver's job card with them. The second half is that a provider that only
 * knows postcodes has nothing useful to offer a chauffeur operator in the first
 * place, so it no longer offers anything.
 *
 * Nothing caught it. There was no browser test of this field at all, and the
 * unit tests covered a function that did not yet exist.
 *
 * The default install is what these tests run against: no Places key, so the
 * field is a plain text box. The suggesting behaviour is tested in the
 * describe below it, which needs a provider connected and skips without one.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/**
 * Set on an install that has Google Places connected.
 *
 * The suggestion path only renders when the server says a provider with a key
 * is configured, and no browser test can turn that on for itself without
 * writing a credential into the install it is running against.
 */
const SUGGESTIONS_ON = process.env.E2E_PLACES_SUGGESTIONS === '1';

const RUN = uniqueDigits(6);

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Stand in for whichever provider is configured.
 *
 * `primary` is what the dropdown shows; `label` is what the detail lookup
 * returns and what the old code wrote into the box unconditionally.
 */
async function stubPlaces(
  page: Page,
  suggestion: { primary: string; secondary: string; label: string },
) {
  await page.route('**/api/places/suggest**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        suggestions: [
          {
            id: 'stub-1',
            primary: suggestion.primary,
            secondary: suggestion.secondary,
            source: 'postcodes',
          },
        ],
      }),
    }),
  );

  await page.route('**/api/places/resolve**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        label: suggestion.label,
        address: suggestion.label,
        postcode: 'SW1A 2AA',
        lat: 51.5034,
        lng: -0.1276,
        locationId: null,
      }),
    }),
  );
}

test.describe('the address field, with no provider connected', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');
  test.skip(SUGGESTIONS_ON, 'this install has a Places provider connected');

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('is a plain text box that asks nothing and offers nothing', async ({
    page,
  }) => {
    /*
     * The fix for the report, at its root. A provider that can only return
     * postcodes must not be given the chance to replace a typed address with
     * one — so with no key configured, no lookup is made at all.
     */
    let asked = 0;
    await page.route('**/api/places/**', (route) => {
      asked += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ suggestions: [] }),
      });
    });

    await page.goto('/jobs/new');
    const typed = '10 Downing Street, London SW1A 2AA';
    await page.getByLabel('Pickup').fill(typed);

    // Long enough for the 250ms debounce to have fired, if there were one.
    await expect(page.getByTestId('pickupText-suggestions')).toBeHidden();
    expect(asked).toBe(0);

    // Announced as a plain field rather than a combobox — telling a screen
    // reader there is a list and then never showing one is worse than saying
    // nothing.
    await expect(page.getByLabel('Pickup')).not.toHaveAttribute('role', 'combobox');

    // Untouched: what was typed is what stays.
    await expect(page.getByLabel('Pickup')).toHaveValue(typed);
  });

  test('still reads the postcode out of what was typed', async ({ page }) => {
    /*
     * The thing plain text would otherwise cost. The postcode resolves the
     * pricing zone, so a field that took the address and dropped the postcode
     * would quietly mis-price every booking taken on it.
     */
    await page.goto('/jobs/new');

    await page.getByLabel('Pickup').fill('Flat 4, 22 Mount Street, Mayfair, London w1k1qa');
    await expect(page.locator('input[name="pickupTextPostcode"]')).toHaveValue(
      // Canonical form, spaced and upper-cased, whatever the operator typed.
      'W1K 1QA',
    );

    // And nothing invented: there are no coordinates to be had from text.
    await expect(page.locator('input[name="pickupTextLat"]')).toHaveValue('');
    await expect(page.locator('input[name="pickupTextLng"]')).toHaveValue('');

    // An address with no postcode in it carries none, rather than a stale one.
    await page.getByLabel('Pickup').fill('The blue gate behind the depot');
    await expect(page.locator('input[name="pickupTextPostcode"]')).toHaveValue('');
  });

  test('carries the full address through to the saved job', async ({
    page,
  }) => {
    /*
     * The end that matters. `pickupText` is what the driver is sent, so a
     * field that holds the right string and a job that stores a different one
     * would be the same failure one step later.
     */
    await page.goto('/jobs/new');
    const pickup = `Flat 4, 22 Mount Street, Mayfair, London W1K 1QA ${RUN}`;

    await page.getByLabel('Pickup').fill(pickup);
    await page.getByLabel('Destination').fill('Heathrow Terminal 5, Longford TW6 2GA');
    await page.getByLabel('Date').fill(dateIn(3));
    await page.getByLabel('Time').fill('09:30');
    // Priced, because an unpriced job cannot be booked without somebody
    // explicitly saying why — the rule is asserted in `jobs.spec.ts`.
    await page.getByLabel('Client price').fill('125.50');
    await page.getByRole('button', { name: 'Book job' }).click();

    // On the job, in full — not reduced to the postcode somewhere in between.
    await expect(page.getByText(pickup).first()).toBeVisible();
  });

  test('accepts an address that is not an address at all', async ({ page }) => {
    /*
     * The escape hatch. Chauffeur pickups are not all postal addresses — a
     * gate, a stand, a spot on a private estate — and a booking must never be
     * blocked because nothing can find one.
     */
    await page.goto('/jobs/new');
    const pickup = `The blue gate behind the depot, no postcode ${RUN}`;

    await page.getByLabel('Pickup').fill(pickup);
    await page.getByLabel('Destination').fill('Gatwick South');
    await page.getByLabel('Date').fill(dateIn(3));
    await page.getByLabel('Time').fill('07:15');
    await page.getByLabel('Client price').fill('98.00');
    await page.getByRole('button', { name: 'Book job' }).click();

    await expect(page.getByText(pickup).first()).toBeVisible();
  });
});

test.describe('the address field, with a provider connected', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');
  test.skip(!SUGGESTIONS_ON, 'set E2E_PLACES_SUGGESTIONS=1 on a connected install');

  /*
   * **The lookup is stubbed.** Both places routes are intercepted, so these
   * depend on no key and no third-party service — and they can assert on
   * labels chosen to make the rule visible, which a live lookup could change
   * under them at any time. What is tested is the component's behaviour, not
   * anybody's address data.
   */

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  /** Type into the pickup box and take the one suggestion offered. */
  async function chooseSuggestion(page: Page, typed: string, shown: string) {
    const pickup = page.getByLabel('Pickup');
    await pickup.fill(typed);

    const list = page.getByTestId('pickupText-suggestions');
    await expect(list).toBeVisible();
    await list.getByRole('option', { name: new RegExp(shown, 'i') }).click();

    // The choose path is two awaits deep — an optimistic write, then the
    // detail lookup — so settle before reading the value.
    await expect(list).toBeHidden();
  }

  test('keeps a pasted street address when the lookup knows less', async ({
    page,
  }) => {
    await stubPlaces(page, {
      primary: 'SW1A 2AA',
      secondary: 'UK postcode',
      label: 'SW1A 2AA',
    });

    await page.goto('/jobs/new');
    const typed = '10 Downing Street, London SW1A 2AA';
    await chooseSuggestion(page, typed, 'SW1A 2AA');

    await expect(page.getByLabel('Pickup')).toHaveValue(typed);

    // The postcode still rides along — losing it would swap one bug for
    // another, since it is what prices the job by zone.
    await expect(page.locator('input[name="pickupTextPostcode"]')).toHaveValue(
      'SW1A 2AA',
    );
  });

  test('takes the label when the lookup genuinely knows more', async ({
    page,
  }) => {
    // The case the overwrite was written for, and it still has to work.
    await stubPlaces(page, {
      primary: 'The Dorchester',
      secondary: 'Park Lane, London',
      label: 'The Dorchester',
    });

    await page.goto('/jobs/new');
    await chooseSuggestion(page, 'dorchester', 'The Dorchester');

    await expect(page.getByLabel('Pickup')).toHaveValue('The Dorchester');
  });
});
