import { expect, test } from '@playwright/test';

/**
 * Phase 0 acceptance: authentication, role enforcement and the shell.
 *
 * These need seeded users. Create them with `npm run db:seed` and set:
 *   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
 *   E2E_VIEWER_EMAIL / E2E_VIEWER_PASSWORD
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL ?? 'viewer@example.com';
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '' && VIEWER_PASSWORD !== '';

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe('unauthenticated access', () => {
  test('redirects every dashboard route to the login page', async ({ page }) => {
    for (const path of ['/', '/jobs', '/drivers', '/invoices', '/settings']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test('health check answers without a session', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
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

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    // The same wording whether the account exists or not.
    await expect(alert).toContainText('not recognised');
    await expect(alert).not.toContainText('password');
    await expect(page).toHaveURL(/\/login/);
  });

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

  test('signing out ends the session', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.getByRole('button', { name: /Administrator|admin/i }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/);

    await page.goto('/jobs');
    await expect(page).toHaveURL(/\/login/);
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
