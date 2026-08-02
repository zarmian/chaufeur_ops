import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 0 acceptance: authentication, role enforcement and the shell.
 *
 * Needs seeded users. Create them with `SEED_E2E_USERS=true npm run db:seed`
 * and set E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD and the VIEWER pair.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL ?? 'viewer@example.com';
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '' && VIEWER_PASSWORD !== '';

/**
 * Sign in, and assert we actually arrived on the dashboard.
 *
 * The landing assertion matters: a session cookie that is set but does not
 * resolve produces a redirect back to /login, and without this check every
 * later assertion fails somewhere confusing instead of here.
 */
async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(
    page.getByRole('navigation', { name: 'Main' }),
    'signed in but the dashboard shell did not render — the session cookie did not resolve',
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('unauthenticated access', () => {
  test('redirects every dashboard route to the login page', async ({ page }) => {
    for (const path of ['/', '/jobs', '/drivers', '/invoices', '/settings']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test('remembers where the user was heading', async ({ page }) => {
    await page.goto('/jobs');
    await expect(page).toHaveURL(/\/login\?next=%2Fjobs/);
  });

  test('health check answers without a session', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      database: 'ok',
    });
  });

  test('cron routes refuse a request with no bearer token', async ({
    request,
  }) => {
    const response = await request.get('/api/cron/housekeeping');
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  test('cron routes refuse a wrong bearer token', async ({ request }) => {
    const response = await request.get('/api/cron/housekeeping', {
      headers: { authorization: 'Bearer not-the-secret' },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('sign in', () => {
  test('rejects a bad password without revealing whether the email exists', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Scoped to the form: Next renders its own role="alert" route announcer
    // on every page, which an unscoped getByRole('alert') matches first.
    const error = page.getByTestId('login-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('not recognised');
    // The wording must not distinguish a wrong password from an unknown
    // address — no "no such user", no "incorrect password".
    await expect(error).not.toContainText(/no such|does not exist|incorrect/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test.describe('with seeded users', () => {
    test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

    test('an admin reaches the dashboard and sees every section', async ({
      page,
    }) => {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      const nav = page.getByRole('navigation', { name: 'Main' });
      for (const label of [
        'Dashboard',
        'Jobs',
        'Dispatch',
        'Drivers',
        'Vehicles',
        'Clients',
        'Accounts',
        'Invoices',
        'Payouts',
        'Reports',
        'Settings',
      ]) {
        await expect(nav.getByRole('link', { name: label })).toBeVisible();
      }
    });

    test('the session survives a full page load', async ({ page }) => {
      // Proves the cookie resolves against the Session table on a fresh
      // request, not just immediately after the sign-in redirect.
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.reload();
      await expect(
        page.getByRole('navigation', { name: 'Main' }),
      ).toBeVisible();
    });

    test('signing out ends the session', async ({ page }) => {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      await page.getByRole('button', { name: /Administrator/i }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.waitForURL(/\/login/);

      // The cookie is gone and the session row deleted, so a protected route
      // bounces rather than serving from a stale cookie.
      await page.goto('/jobs');
      await expect(page).toHaveURL(/\/login/);
    });
  });
});

test.describe('role enforcement', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('a VIEWER does not see admin-only navigation', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Jobs' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Dispatch' })).toHaveCount(0);
  });

  test('a VIEWER is refused a page their role cannot reach, not merely unlinked', async ({
    page,
  }) => {
    // Hiding the link is cosmetic. Navigating straight to the URL must still
    // be refused server-side — as a 404, so the screen's existence is not
    // confirmed to a role that cannot use it.
    await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);

    const response = await page.goto('/settings');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Page not found')).toBeVisible();
  });
});
