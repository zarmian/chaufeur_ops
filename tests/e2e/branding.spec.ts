import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * Phase 3 acceptance: the install is re-skinnable by changing settings.
 *
 * The claim being tested is the one the whole phase rests on — that a saved
 * colour reaches the stylesheet without a rebuild, that a saved name reaches
 * the page title and the sidebar, and that a prefix typed in lower case comes
 * back upper-cased because it ends up printed on paperwork.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const OPS_EMAIL = process.env.E2E_OPS_EMAIL ?? 'ops@example.com';
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Save the branding form and wait for the redirect to land. */
async function saveBranding(page: Page) {
  await Promise.all([
    page.waitForURL(/[?&](updated|brandingError)=/, { timeout: 15_000 }),
    page.getByRole('button', { name: 'Save branding' }).click(),
  ]);
}

test.describe('branding', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');
  // Serially: these tests all write the one global branding record, and
  // running them in parallel would have them overwrite each other.
  test.describe.configure({ mode: 'serial' });

  test('a saved colour reaches the stylesheet with no rebuild', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    // #ff0000 is 0 100% 50% in HSL — an unmistakable triplet to look for.
    await page.getByLabel('Primary', { exact: true }).fill('#ff0000');
    await saveBranding(page);
    await expect(page.getByTestId('branding-saved')).toBeVisible();

    // Straight to another page: the theme is written by the root layout, so
    // it has to be there on a route that knows nothing about settings.
    await page.goto('/jobs');
    const themeCss = await page.locator('#brand-theme').textContent();
    expect(themeCss).toContain('--primary:0 100% 50%');

    // And it is really applied, not merely present in a style element.
    const applied = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary'),
    );
    expect(applied.trim()).toBe('0 100% 50%');
  });

  test('the semantic states survive a brand colour', async ({ page }) => {
    // A red that means "expired" must not become a customer's brand colour.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');
    await page.getByLabel('Primary', { exact: true }).fill('#1f6feb');
    await page.getByLabel('Accent', { exact: true }).fill('#00aa55');
    await saveBranding(page);

    await page.goto('/compliance');
    const themeCss = (await page.locator('#brand-theme').textContent()) ?? '';
    expect(themeCss).not.toContain('--destructive');
    expect(themeCss).not.toContain('--success');
    expect(themeCss).not.toContain('--warning');
  });

  test('the trading name reaches the sidebar and the page title', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    const name = `Northwind ${uniqueDigits(5)}`;
    await page.getByLabel('Trading name').fill(name);
    await saveBranding(page);

    await page.goto('/jobs');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.locator('body')).toContainText(name);
    // The metadata template is `%s · <trading name>`.
    await expect(page).toHaveTitle(new RegExp(name));
  });

  test('a reference prefix is upper-cased and previewed', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    const field = page.getByLabel('Job reference');
    await field.fill('nwc');
    // The hint updates as you type, so the shape is visible before saving.
    await expect(page.getByText('NWC-000767')).toBeVisible();

    await saveBranding(page);
    await page.reload();
    await expect(page.getByLabel('Job reference')).toHaveValue('NWC');
  });

  test('a colour that fails contrast warns rather than being refused', async ({
    page,
  }) => {
    // The brand is the customer's decision. They should hear about it here
    // rather than from a user who cannot read a link in it.
    //
    // Checked as text on white, which is the pairing that can actually fail.
    // Against its own button foreground a brand always passes, because the
    // label switches to whichever of black or white reads better.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    const field = page.getByLabel('Primary', { exact: true });

    // A pale yellow: unreadable as a link, fine as a button with black text.
    await field.fill('#ffe066');
    await expect(page.getByTestId('primaryColour-contrast')).toContainText(
      'hard to read',
    );

    // A dark navy passes and says so, rather than staying silent.
    await field.fill('#0b1f3a');
    await expect(page.getByTestId('primaryColour-contrast')).toHaveCount(0);
    await expect(page.getByText(/Passes WCAG AA/)).toBeVisible();

    // Either way it saves — a warning, not a refusal.
    await field.fill('#ffe066');
    await saveBranding(page);
    await expect(page.getByTestId('branding-saved')).toBeVisible();
  });

  test('a malformed colour is refused', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    await page.getByLabel('Primary', { exact: true }).fill('rebeccapurple');
    await saveBranding(page);
    await expect(page.getByTestId('branding-error')).toBeVisible();
  });

  test('a logo can be set without file storage configured', async ({ page }) => {
    // The gap this closes: with no Blob store the whole logo section was
    // replaced by a warning, so a deployment without one had no way to set a
    // logo at all — the white-label promise made conditional on a piece of
    // infrastructure that has nothing to do with branding.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    // The section is always there, whichever way round storage is.
    await expect(page.getByTestId('asset-logoLightUrl')).toBeVisible();
    const link = page
      .getByTestId('asset-logoLightUrl')
      .getByLabel(/[Ll]ink to one you host/);
    await expect(link).toBeVisible();

    await link.fill('https://example.test/logo.svg');
    await saveBranding(page);
    await expect(page.getByTestId('branding-saved')).toBeVisible();

    // It renders straight from the address, not through the signed-URL route
    // — there is no stored object to sign.
    await page.goto('/jobs');
    const logo = page.locator('img[src="https://example.test/logo.svg"]');
    await expect(logo.first()).toHaveCount(1);
  });

  test('a plain http logo address is refused', async ({ page }) => {
    // It would save and then simply not appear: the browser blocks mixed
    // content on a secure page. Better to say so than to look broken.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    await page
      .getByTestId('asset-logoLightUrl')
      .getByLabel(/[Ll]ink to one you host/)
      .fill('http://example.test/logo.svg');
    await saveBranding(page);
    await expect(page.getByTestId('branding-error')).toContainText('https://');
  });

  test('a stored logo can be removed again', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/branding');

    await page
      .getByTestId('asset-logoLightUrl')
      .getByLabel(/[Ll]ink to one you host/)
      .fill('https://example.test/logo.svg');
    await saveBranding(page);

    await page.getByTestId('asset-logoLightUrl').getByText('Remove').click();
    await saveBranding(page);

    await expect(
      page.getByTestId('asset-logoLightUrl').getByText('Not set'),
    ).toBeVisible();
  });

  test('branding is ADMIN only', async ({ page }) => {
    test.skip(OPS_PASSWORD === '', 'no OPS credentials configured');
    await signIn(page, OPS_EMAIL, OPS_PASSWORD);

    await page.goto('/settings/branding');
    await expect(page.getByTestId('branding-form')).toHaveCount(0);
  });
});

test.describe('locale', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');
  test.describe.configure({ mode: 'serial' });

  test('a non-UK configuration changes how money and time render', async ({
    page,
  }) => {
    // Spec 3.6.6 — the proof that nothing is hardcoded.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/locale');

    await expect(page.getByText('£1,255.50')).toBeVisible();

    await page.getByLabel('Currency').fill('USD');
    await page.getByLabel('Locale').fill('en-US');
    await page.getByLabel('Timezone').fill('America/New_York');
    await page.getByLabel('Tax name').fill('Sales tax');
    await page.getByLabel('Default rate (%)').fill('8.875');
    await Promise.all([
      page.waitForURL(/[?&](updated|localeError)=/, { timeout: 15_000 }),
      page.getByRole('button', { name: 'Save locale' }).click(),
    ]);

    await expect(page.getByTestId('locale-saved')).toBeVisible();
    await expect(page.getByText('$1,255.50')).toBeVisible();
    await expect(page.getByText('Sales tax at 8.875%')).toBeVisible();

    // The document language follows too.
    expect(await page.locator('html').getAttribute('lang')).toBe('en-US');

    // Put it back, so the other specs see the UK defaults they expect.
    await page.getByLabel('Currency').fill('GBP');
    await page.getByLabel('Locale').fill('en-GB');
    await page.getByLabel('Timezone').fill('Europe/London');
    await page.getByLabel('Tax name').fill('VAT');
    await page.getByLabel('Default rate (%)').fill('20');
    await Promise.all([
      page.waitForURL(/[?&](updated|localeError)=/, { timeout: 15_000 }),
      page.getByRole('button', { name: 'Save locale' }).click(),
    ]);
    await expect(page.getByText('£1,255.50')).toBeVisible();
  });

  test('a timezone the platform cannot use is refused', async ({ page }) => {
    // Stored, it would throw inside Intl on whichever page shows a time
    // first — a runtime error a long way from the setting that caused it.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/locale');

    await page.getByLabel('Timezone').fill('Mars/Olympus_Mons');
    await Promise.all([
      page.waitForURL(/[?&](updated|localeError)=/, { timeout: 15_000 }),
      page.getByRole('button', { name: 'Save locale' }).click(),
    ]);
    await expect(page.getByTestId('locale-error')).toBeVisible();
  });
});
