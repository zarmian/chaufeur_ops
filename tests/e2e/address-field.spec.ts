import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * What the pickup box holds after somebody uses it.
 *
 * The rule is unit-tested in `lib/places/places.test.ts`. What only a browser
 * can show is whether the rule is actually wired to the field — and the bug
 * that prompted this lived exactly there. Choosing a suggestion overwrote the
 * box with the provider's label, so on the default postcode provider a pasted
 * street address became a bare postcode: the building, the street and the
 * number gone, and gone from the driver's job card with them.
 *
 * Nothing caught it. There was no browser test of this field at all, and the
 * unit tests covered a function that did not yet exist.
 *
 * **The lookup is stubbed.** Both places routes are intercepted, so this
 * depends on no provider, no key and no third-party service — and it can
 * assert on labels chosen to make the rule visible, which a live lookup could
 * change under it at any time. What is being tested is the component's
 * behaviour, not anybody's address data.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

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

/** Type into the pickup box and take the one suggestion offered. */
async function chooseSuggestion(page: Page, typed: string, shown: string) {
  const pickup = page.getByLabel('Pickup');
  await pickup.fill(typed);

  const list = page.getByTestId('pickupText-suggestions');
  await expect(list).toBeVisible();
  await list.getByRole('option', { name: new RegExp(shown, 'i') }).click();

  // The choose path is two awaits deep — an optimistic write, then the detail
  // lookup — so settle before reading the value.
  await expect(list).toBeHidden();
}

test.describe('the address field', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('keeps a pasted street address when the lookup only knows the postcode', async ({
    page,
  }) => {
    // The report, in a browser. This is what the postcode provider does on
    // every install with no Google key — which is the default.
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

  test('carries the full address through to the saved job', async ({
    page,
  }) => {
    /*
     * The end that matters. `pickupText` is what the driver is sent, so a
     * field that holds the right string and a job that stores a different one
     * would be the same failure one step later.
     */
    await stubPlaces(page, {
      primary: 'W1K 1QA',
      secondary: 'UK postcode',
      label: 'W1K 1QA',
    });

    await page.goto('/jobs/new');
    const pickup = `Flat 4, 22 Mount Street, Mayfair, London W1K 1QA ${RUN}`;

    await page.getByLabel('Pickup').fill(pickup);
    const list = page.getByTestId('pickupText-suggestions');
    await expect(list).toBeVisible();
    await list.getByRole('option').first().click();
    await expect(list).toBeHidden();

    await page.getByLabel('Destination').fill('Heathrow Terminal 5');
    await page.getByLabel('Date').fill(dateIn(3));
    await page.getByLabel('Time').fill('09:30');
    // Priced, because an unpriced job cannot be booked without somebody
    // explicitly saying why — the rule is asserted in `jobs.spec.ts`.
    await page.getByLabel('Client price').fill('125.50');
    await page.getByRole('button', { name: 'Book job' }).click();

    // On the job, in full — not reduced to the postcode somewhere in between.
    await expect(page.getByText(pickup).first()).toBeVisible();
  });

  test('accepts an address nothing was chosen for', async ({ page }) => {
    /*
     * The escape hatch, and the answer to "the field only takes postcodes".
     * A provider that cannot find a place must never stop the booking: typing
     * the address and ignoring the dropdown has always worked, and this is
     * what keeps it working.
     */
    await stubPlaces(page, {
      primary: 'SW1A 2AA',
      secondary: 'UK postcode',
      label: 'SW1A 2AA',
    });

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
