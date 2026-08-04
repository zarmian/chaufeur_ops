import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 1 acceptance: create a driver, give them a badge expiring in five
 * days, and confirm it lands in the critical bucket.
 *
 * This is the walk-through the spec names, and it is the one that matters:
 * it exercises the whole chain from a date typed into a form, through the
 * classification rules, to the number on the dashboard that protects the
 * operator licence.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL ?? 'viewer@example.com';
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '' && VIEWER_PASSWORD !== '';

/** `YYYY-MM-DD`, N days from now — so the fixture never goes stale. */
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

test.describe('compliance', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('a badge expiring in five days lands in the critical bucket', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const name = `Critical Tester ${Date.now()}`;

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone').fill('07700 900999');
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(5));
    await page.getByRole('button', { name: 'Add driver' }).click();

    // Lands on the detail page, still assignable — expiring is a nudge, not
    // a block.
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('Expiring', { exact: false }).first()).toBeVisible();
    await expect(
      page.getByText('cannot be assigned to a job'),
    ).toHaveCount(0);

    // And it appears in the critical bucket on the compliance screen.
    await page.goto('/compliance?level=critical');
    await expect(page.getByRole('link', { name })).toBeVisible();
    await expect(page.getByText('PHV badge').first()).toBeVisible();
  });

  test('a lapsed badge blocks assignment and says why', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const name = `Expired Tester ${Date.now()}`;

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone').fill('07700 900998');
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(-10));
    await page.getByRole('button', { name: 'Add driver' }).click();

    await expect(page.getByText('cannot be assigned to a job')).toBeVisible();
    await expect(page.getByText(/PHV badge expired 10 days ago/)).toBeVisible();
  });

  test('a missing expiry date is not treated as compliant', async ({ page }) => {
    // The legacy system's defining assumption, and the one being replaced.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const name = `Undated Tester ${Date.now()}`;

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone').fill('07700 900997');
    // Both dates deliberately left blank.
    await page.getByRole('button', { name: 'Add driver' }).click();

    await expect(page.getByText('cannot be assigned to a job')).toBeVisible();
    await expect(
      page.getByText(/has no expiry date recorded/).first(),
    ).toBeVisible();
  });

  test('the expiring API returns the documented buckets', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Issued from inside the page rather than through `page.request`.
    // A production build names the cookie `__Secure-ops_session` and sets
    // `Secure`, and Playwright's Node-side HTTP client will not send a Secure
    // cookie over the plain-HTTP loopback the test server runs on — so the
    // call arrives anonymous and middleware redirects it to /login, which
    // answers 200 with HTML. Chromium treats loopback as trustworthy and
    // sends the cookie, which is also how the app really calls this route.
    const response = await page.evaluate(async () => {
      const r = await fetch('/api/compliance/expiring?days=60');
      return { status: r.status, body: (await r.json()) as unknown };
    });
    expect(response.status).toBe(200);

    const body = response.body as Record<string, unknown>;
    expect(body).toHaveProperty('expired');
    expect(body).toHaveProperty('critical');
    expect(body).toHaveProperty('warning');
    expect(body).toHaveProperty('counts');
    expect(Array.isArray(body.expired)).toBe(true);
  });

  test('a duplicate registration is refused and names the existing vehicle', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const plate = `ZZ${String(Date.now()).slice(-2)} ABC`;

    for (const attempt of [1, 2]) {
      await page.goto('/vehicles/new');
      await page.getByLabel('Registration').fill(plate);
      await page.getByLabel('Make').fill('Mercedes-Benz');
      await page.getByLabel('Model').fill('E-Class');
      await page.getByRole('button', { name: 'Add vehicle' }).click();

      if (attempt === 1) {
        await expect(page.getByRole('heading', { name: plate })).toBeVisible();
      }
    }

    // Spacing and case must not let a second copy through.
    await expect(page.getByText('already on the fleet')).toBeVisible();
  });

  test('a VIEWER cannot reach the create forms', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);

    // Compliance is readable by every role — it is information, not a control.
    await page.goto('/compliance');
    await expect(page.getByRole('heading', { name: 'Compliance' })).toBeVisible();

    // Creating is not.
    await page.goto('/drivers/new');
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add driver' })).toHaveCount(0);
  });
});
