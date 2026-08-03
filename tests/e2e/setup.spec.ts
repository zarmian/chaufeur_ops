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

  test('says nothing about why it is gone', async ({ page }) => {
    // A claimed install renders the ordinary not-found page — no "already set
    // up" message, and nothing that would help someone decide whether it is
    // worth guessing the token.
    //
    // Note this is *not* indistinguishable from any other unknown URL: an
    // unknown path redirects an anonymous visitor to /login (200), whereas
    // /setup is public and 404s. That difference reveals only that the
    // bootstrap has been used, which an unclaimed install would advertise far
    // more loudly by showing the form.
    await page.goto('/setup');

    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toMatch(/already|token|administrator exists/i);
    await expect(page.getByText('Page not found')).toBeVisible();
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
