import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4.1 and 4.2 acceptance, end to end.
 *
 * The phase exists to stop prices being typed twice. What only this can prove
 * is that a rule configured in Settings actually reaches the booking form —
 * the matching order is unit-tested exhaustively and none of that matters if
 * the suggestion never appears in the field.
 *
 * The second half is the part the spec is most particular about: the
 * suggestion is *visible* as a suggestion, and overriding it is free.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/**
 * A postcode prefix of this run's own.
 *
 * Two active zones claiming one prefix is refused — correctly, since the
 * match would otherwise depend on row order — so a fixed prefix would make
 * the second run of this test fail on the first run's leftovers. `ZQ` is not
 * a real UK postcode area, and the shape matches what the outward-code
 * extractor looks for.
 */
const TEST_PREFIX = `ZQ${Math.floor(Math.random() * 10)}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]}`;

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

test.describe('rate cards', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  /**
   * Leave no live default card behind, even when the test fails part way.
   *
   * A default rate card is global state: every booking in every other spec
   * asks it for a price. One left enabled by a failed run makes the *next*
   * run's failures look like flakes in whichever spec happened to go second.
   */
  test.afterEach(async ({ page }) => {
    await page.goto('/settings/pricing/rate-cards').catch(() => {});
    const retire = page
      .locator('[data-testid^="retire-"]')
      .filter({ has: page.getByRole('button', { name: 'Retire' }) });

    for (const card of await page.locator('[data-testid^="retire-"]').all()) {
      const enclosing = card.locator('..').locator('..');
      if ((await enclosing.getByText(/E2E card/).count()) === 0) continue;
      await card.getByRole('button', { name: 'Retire' }).click();
      await page.waitForLoadState('load').catch(() => {});
      await page.goto('/settings/pricing/rate-cards').catch(() => {});
    }
    void retire;
  });

  test('a rule configured in settings prices a booking, and can be overridden', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const stamp = String(Date.now()).slice(-6);
    const zoneName = `Testport ${stamp}`;
    const cardName = `E2E card ${stamp}`;

    // 4.1.1 — a zone is a name and a list of postcode prefixes.
    await page.goto('/settings/pricing/zones');
    const zoneForm = page.getByTestId('zone-form');
    await zoneForm.getByLabel('Name').fill(zoneName);
    await zoneForm.getByLabel('Postcode prefixes').fill(TEST_PREFIX);
    await zoneForm.getByRole('button', { name: 'Add zone' }).click();
    await expect(page.getByTestId('zone-error')).toHaveCount(0);
    await expect(page.getByText(zoneName)).toBeVisible();

    // 4.2.1 — a card with dates and a default flag.
    await page.goto('/settings/pricing/rate-cards');
    const cardForm = page.getByTestId('rate-card-form');
    await cardForm.getByLabel('Name').fill(cardName);
    await cardForm.getByLabel('Applies from').fill(dateIn(-30));
    await cardForm.getByLabel('Make this the default').check();
    await cardForm.getByRole('button', { name: 'Add rate card' }).click();
    await expect(page.getByText(cardName)).toBeVisible();

    // Navigated by href rather than by clicking: the list is a stack of
    // cards and which one a click lands on is not something this test is
    // about.
    const cardHref = await page
      .getByRole('link', { name: cardName })
      .getAttribute('href');
    expect(cardHref).toBeTruthy();
    await page.goto(cardHref!);
    await expect(page.getByRole('heading', { name: cardName })).toBeVisible();
    const cardUrl = page.url().split('?')[0]!;

    // 4.2.5 — a rule cannot pay the driver a percentage *and* a fixed amount.
    const ruleForm = page.getByTestId('rule-form');
    await selectByOptionText(page, '#fromZoneId', zoneName);
    await ruleForm.getByLabel('Base fare').fill('142.00');
    await ruleForm.getByLabel('Base', { exact: true }).fill('90.00');
    await ruleForm.getByLabel('% of fare').fill('70');
    await ruleForm.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByTestId('rule-error')).toContainText('never both');

    // Corrected: a percentage alone.
    await page.goto(cardUrl);
    await selectByOptionText(page, '#fromZoneId', zoneName);
    await page.getByTestId('rule-form').getByLabel('Base fare').fill('142.00');
    await page.getByTestId('rule-form').getByLabel('% of fare').fill('70');
    await page.getByTestId('rule-form').getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByTestId('rule-error')).toHaveCount(0);
    await expect(page.getByText(`${zoneName} → anywhere`)).toBeVisible();

    // 4.2.7 — the booking form asks the card and pre-fills both fields, with
    // a marker saying where the number came from.
    await page.goto('/jobs/new');
    await page.getByLabel('Date').fill(dateIn(3));
    await page.getByLabel('Time').fill('14:30');
    await page.getByLabel('Pickup').fill(`Somewhere, ${TEST_PREFIX} 1AA`);
    await page.getByLabel('Destination').fill('Mayfair');
    // The card is asked when a field is left, not on every keystroke — so
    // the destination has to lose focus, exactly as it would for somebody
    // tabbing on to the next field.
    await page.getByLabel('Destination').blur();

    const suggestion = page.getByTestId('rate-card-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 15_000 });
    await expect(suggestion).toContainText(cardName);
    await expect(suggestion).toContainText(zoneName);

    await expect(page.getByLabel('Client price')).toHaveValue('142.00');
    // 70% of £142.00, computed by the server from the rule — the form never
    // works a fare out for itself.
    await expect(page.getByLabel('Driver price')).toHaveValue('99.40');

    const marker = page.getByText('From the rate card —');
    await expect(marker).toHaveCount(2);

    // 4.2.7 — full manual override. The marker is per field, so changing the
    // fare leaves the driver's share still marked: it is still what the card
    // said, and pretending otherwise would be the lie.
    await page.getByLabel('Client price').fill('160.00');
    await expect(marker).toHaveCount(1);
    await expect(page.getByLabel('Client price')).toHaveValue('160.00');
    await expect(page.getByLabel('Driver price')).toHaveValue('99.40');

    await page.getByLabel('Driver price').fill('110.00');
    await expect(marker).toHaveCount(0);

    await page.getByRole('button', { name: 'Book job' }).click();
    await expect(page.getByTestId('unpriced-alert')).toHaveCount(0);

    // 4.2.8 — the override is on the record, not only the agreed price.
    await expect(page.getByText('£160.00').first()).toBeVisible();

    // 4.2.10 — the card priced a job, so retiring it end-dates rather than
    // removes it. The job's price has to stay explicable.
    await page.goto('/settings/pricing/rate-cards');
    await page
      .getByTestId(`retire-${cardUrl.split('/').pop()}`)
      .getByRole('button', { name: 'Retire' })
      .click();

    await expect(page.getByTestId('card-notice')).toContainText('end-dated');
    // Still listed, and still openable: the job it priced has to stay
    // explicable, which a deleted card would make impossible.
    await expect(page.getByRole('link', { name: cardName })).toBeVisible();
  });
});
