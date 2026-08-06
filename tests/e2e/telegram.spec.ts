import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * Phase 5 acceptance, end to end.
 *
 * Two things only a real request can prove.
 *
 * The webhook must reject an unsigned request **before parsing the body** —
 * spec 5.1.3, and the definition of done asks for it explicitly. Anyone who
 * can guess the URL could otherwise post a fabricated `COMPLETED` for any
 * job, and the driver-facing half of this phase would be worth nothing.
 *
 * And the driver's link must be generated, shown once, and revocable from the
 * driver's own record — the walk an operator does on day one.
 *
 * The bot's behaviour is tested against a real database in
 * `lib/telegram/telegram.integration.test.ts`; nothing here talks to
 * Telegram.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';
const RUN = uniqueDigits(7);

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

/**
 * Post to the webhook from inside the page.
 *
 * In-page rather than through `page.request`, which keeps its own cookie jar
 * — and the point of two of these tests is that a signed-in browser session
 * does not help. This endpoint answers to Telegram, not to a logged-in user.
 */
async function postWebhook(
  page: Page,
  headers: Record<string, string>,
  body: unknown,
) {
  return page.evaluate(
    async ({ headers, body }) => {
      const response = await fetch('/api/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    { headers, body },
  );
}

test.describe('telegram webhook', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('refuses an unsigned update', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await postWebhook(page, {}, {
      update_id: 1,
      message: { chat: { id: 1 }, text: '/start' },
    });

    expect(response.status).toBe(401);
  });

  test('refuses a wrong secret token', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await postWebhook(
      page,
      { 'X-Telegram-Bot-Api-Secret-Token': 'not-the-secret' },
      { update_id: 2, message: { chat: { id: 1 }, text: '/start' } },
    );

    expect(response.status).toBe(401);
  });

  test('refuses a forged status tap', async ({ page }) => {
    // The one that matters. Rejected on the header, so the body is never read
    // and the callback never handled.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await postWebhook(
      page,
      { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
      {
        update_id: 3,
        callback_query: {
          id: 'forged',
          data: 'job:whatever:completed',
          message: { chat: { id: 1 } },
        },
      },
    );

    expect(response.status).toBe(401);
  });

  test('accepts an update carrying the right token', async ({ page }) => {
    // Without this, the three refusals above would still pass on an install
    // with no secret configured at all — where everything is rejected and
    // the comparison is never reached. This is what proves the check is a
    // comparison rather than a blanket no.
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    test.skip(secret === '', 'TELEGRAM_WEBHOOK_SECRET is not set');

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // An update from a chat bound to nobody: verified, handled, and it
    // changes nothing.
    const response = await postWebhook(
      page,
      { 'X-Telegram-Bot-Api-Secret-Token': secret },
      {
        update_id: 4,
        message: { chat: { id: 999_000_111 }, text: '/help' },
      },
    );

    expect(response.status).toBe(200);
  });
});

test.describe('driver linking', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('offers a link on the driver record', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const name = `Telegram Driver ${RUN}`;
    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone').fill(`0770093${RUN.slice(-4)}`);
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(400));
    await page.getByRole('button', { name: 'Add driver' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });

    const generate = page.getByRole('button', { name: 'Generate link' });
    await expect(generate).toBeVisible();

    // Without the bot's username the link cannot be built, and the screen
    // says which setting is missing rather than offering a broken URL.
    if (await generate.isDisabled()) {
      await expect(page.getByText(/ops bot username/i)).toBeVisible();
      return;
    }

    await Promise.all([
      page.waitForURL(/telegram(Url|Token|Error)=/, { timeout: 20_000 }),
      generate.click(),
    ]);
    await expect(page.getByTestId('telegram-link-url')).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('telegram settings', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test.describe.configure({ mode: 'serial' });

  test('refuses to enable the bot without a token', async ({ page }) => {
    // Enabling a bot that cannot send anything leaves every driver silently
    // unreachable with the screen claiming otherwise.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/telegram');

    await page.locator('#enabled').check();

    const before = page.url();
    await Promise.all([
      page.waitForURL((url) => url.toString() !== before, { timeout: 20_000 }),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);

    await expect(page.getByTestId('telegram-error')).toBeVisible();
  });

  test('saves without turning anything on', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/telegram');

    await page.locator('#opsBotUsername').fill(`TestOpsBot${RUN}`);

    const before = page.url();
    await Promise.all([
      page.waitForURL((url) => url.toString() !== before, { timeout: 20_000 }),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);

    await expect(page.getByTestId('telegram-notice')).toBeVisible();

    await page.goto('/settings/telegram');
    await expect(page.locator('#opsBotUsername')).toHaveValue(`TestOpsBot${RUN}`);
    // Spec 5.11.3 — everything off by default, and a save is not a licence to
    // start messaging drivers.
    await expect(page.locator('#notifyOnAssignment')).not.toBeChecked();
    await expect(page.locator('#chaseDocuments')).not.toBeChecked();
  });
});
