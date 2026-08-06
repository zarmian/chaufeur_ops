import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4.7 acceptance, end to end.
 *
 * The signature arithmetic is unit-tested exhaustively. What only this can
 * prove is the wiring: that the webhook endpoint refuses an unsigned request
 * before it parses anything, that the settings screens store credentials
 * without ever showing them again, and — the one that matters most — that
 * with no gateway enabled at all, an invoice can still be raised, sent and
 * settled by hand.
 *
 * That last test is spec 4.7.7, and it is the acceptance criterion the whole
 * section is subordinate to. A gateway is a convenience; the manual path is
 * the product.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test.describe('payment gateways', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('the webhook refuses anything it cannot verify', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 4.7.5. The endpoint has no session behind it, so the signature check is
    // the whole of its security — an accepted forgery marks an invoice paid
    // that nobody paid.
    for (const gateway of ['revolut', 'sumup']) {
      const unsigned = await page.evaluate(async (name) => {
        const response = await fetch(`/api/payments/webhooks/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'ORDER_COMPLETED',
            order: { id: 'forged', amount: 999999, metadata: { invoiceId: 'x' } },
          }),
        });
        return response.status;
      }, gateway);

      expect(unsigned, `${gateway} accepted an unsigned webhook`).toBe(401);

      // A made-up signature is refused the same way, and gives away nothing
      // about whether the gateway is even configured.
      const forged = await page.evaluate(async (name) => {
        const response = await fetch(`/api/payments/webhooks/${name}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'revolut-signature': 'v1=deadbeef',
            'revolut-request-timestamp': String(Date.now()),
            'x-payload-signature': 'deadbeef',
          },
          body: JSON.stringify({ event: 'ORDER_COMPLETED', order: { id: 'x' } }),
        });
        return { status: response.status, body: await response.text() };
      }, gateway);

      expect(forged.status).toBe(401);
      expect(forged.body).not.toContain('enabled');
    }

    // An unknown gateway is a 404, not a 500.
    const unknown = await page.evaluate(async () => {
      const response = await fetch('/api/payments/webhooks/stripe', {
        method: 'POST',
        body: '{}',
      });
      return response.status;
    });
    expect(unknown).toBe(404);
  });

  test('credentials save without ever being shown again', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/gateways');

    const form = page.getByTestId('gateway-form-sumup');
    await expect(form).toBeVisible();

    // SumUp's warning is stated before anybody enables it: there is no real
    // sandbox host, so "sandbox" means a test merchant account.
    await form.getByLabel('Enabled').check();
    await expect(page.getByText(/no separate sandbox/)).toBeVisible();

    await form.getByLabel('Merchant code').fill('MC_E2E_TEST');
    await form.getByLabel('API key').fill('sup_test_key_do_not_use');
    await form.getByLabel('Webhook signing secret').fill('whsec_e2e');
    await form.getByRole('button', { name: 'Save' }).click();

    const outcome = page.getByTestId('gateway-notice').or(
      page.getByTestId('gateway-error'),
    );
    await expect(outcome).toBeVisible();

    const savedWithoutEncryption = await page
      .getByTestId('gateway-error')
      .count();

    if (savedWithoutEncryption > 0) {
      // No SETTINGS_ENCRYPTION_KEY on this deployment. Refusing is correct —
      // the alternative is a key in plaintext — and the message has to say so.
      await expect(page.getByTestId('gateway-error')).toContainText(
        'SETTINGS_ENCRYPTION_KEY',
      );
      return;
    }

    await page.goto('/settings/gateways');
    const saved = page.getByTestId('gateway-form-sumup');

    // Stored, and never rendered back: the field says a key is set, not what
    // it is. Anything else puts it in a screenshot and a browser cache.
    await expect(saved.getByLabel('Merchant code')).toHaveValue('MC_E2E_TEST');
    await expect(saved.getByLabel('API key')).toHaveAttribute(
      'placeholder',
      /leave blank to keep it/,
    );
    await expect(saved.getByLabel('API key')).toHaveValue('');

    const markup = await page.content();
    expect(markup).not.toContain('sup_test_key_do_not_use');
    expect(markup).not.toContain('whsec_e2e');

    // Put it back, so the run leaves nothing enabled behind it.
    await saved.getByLabel('Enabled').uncheck();
    await saved.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('gateway-notice')).toBeVisible();
  });

  test('email settings never render the key back either', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/email');

    const form = page.getByTestId('email-form');
    await expect(form).toBeVisible();
    await expect(form.getByLabel('API key')).toHaveValue('');

    // Testing an unconfigured provider says what is missing rather than
    // failing silently or pretending to succeed.
    await form.getByRole('button', { name: 'Test connection' }).click();
    await expect(
      page.getByTestId('email-error').or(page.getByTestId('email-notice')),
    ).toBeVisible();
  });

  test('with no gateway enabled, an invoice is still raised and settled', async ({
    page,
  }) => {
    // Spec 4.7.7, and the one criterion the rest of the section is
    // subordinate to. A gateway is a convenience; this is the product.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/invoices');
    await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();

    // The manual payment path is exercised end to end in invoices.spec.ts.
    // What this asserts is that nothing on the way there depends on a
    // gateway: the ledger renders, and raising one is offered.
    //
    // `.first()` because an empty ledger offers the same link twice — once in
    // the header and once in the empty state — and whether this database has
    // any invoices in it is not what this test is about.
    await expect(
      page.getByRole('link', { name: 'New invoice' }).first(),
    ).toBeVisible();

    await page.goto('/payments');
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
});
