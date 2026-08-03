import { expect, test } from '@playwright/test';

/**
 * The bootstrap page is a public, unauthenticated surface, so the thing worth
 * testing here is that it is inert on an install that already has an
 * administrator. CI seeds one before this runs, which is exactly the
 * production state.
 *
 * The "creates the first admin" and "refuses a second run" cases live in
 * lib/install.integration.test.ts, where a fresh install can be simulated
 * without tearing down the seeded database the rest of the suite needs.
 */

test.describe('first-run bootstrap', () => {
  test('is gone once an administrator exists', async ({ page }) => {
    const response = await page.goto('/setup');

    expect(response?.status()).toBe(404);
    await expect(page.getByLabel('Setup token')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Create administrator/i })).toHaveCount(0);
  });

  test('does not hint at the install state to an anonymous caller', async ({
    page,
  }) => {
    // Same response as any other unknown URL — no "already set up" message
    // that would confirm a live deployment sitting behind the URL.
    const setup = await page.goto('/setup');
    const nonsense = await page.goto('/definitely-not-a-route');
    expect(setup?.status()).toBe(nonsense?.status());
  });

  test('is reachable without a session, unlike the dashboard', async ({
    page,
  }) => {
    // Middleware must let /setup through: a fresh install has no user who
    // could possibly be signed in, so a redirect to /login would be a
    // bootstrap deadlock.
    await page.goto('/setup');
    await expect(page).not.toHaveURL(/\/login/);
  });
});
