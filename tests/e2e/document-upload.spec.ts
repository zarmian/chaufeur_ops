import { expect, test, type Page } from '@playwright/test';

/**
 * Who may have an upload authorised, and for which record.
 *
 * Documents go from the browser straight to Blob storage, so the browser
 * names the pathname it wants to write and this route decides whether to sign
 * a token for it. That makes the route the entire access control for uploads
 * — there is no second chance further down, because the write does not come
 * back through the application.
 *
 * The key arithmetic is unit-tested in `lib/storage-keys.test.ts`. What only
 * this can prove is that the route actually applies it: that a signed-in
 * operator cannot have a token minted for another vehicle's folder by editing
 * one field in a request, and that a signed-out one gets nothing at all.
 *
 * No Blob store is involved. Generating a client token is local signing, so a
 * syntactically valid dummy `BLOB_READ_WRITE_TOKEN` is enough to exercise
 * every branch above it — which is the half that matters here.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Two vehicle ids from the list, so one can stand in for "somebody else". */
async function twoVehicleIds(page: Page): Promise<[string, string]> {
  await page.goto('/vehicles');
  const hrefs = await page
    .locator('a[href^="/vehicles/"]')
    .evaluateAll((links) =>
      links
        .map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? '')
        .filter((href) => /^\/vehicles\/[^/]+$/.test(href))
        .map((href) => href.split('/')[2] ?? ''),
    );
  // `/vehicles/new` matches the shape of a detail link and is not a record —
  // asking for a token against it fails as "no such vehicle", which would
  // look like the ownership check firing when it never ran.
  const unique = [...new Set(hrefs)].filter(
    (id) => id !== '' && id !== 'new' && !id.startsWith('?'),
  );
  expect(unique.length, 'needs two vehicles in the database').toBeGreaterThan(1);
  return [unique[0]!, unique[1]!];
}

interface TokenAttempt {
  status: number;
  body: string;
  landedOn: string;
}

/**
 * Ask the route for a token, from inside the browser.
 *
 * Deliberately `page.evaluate` and not Playwright's request client. The
 * session cookie is `__Secure-` prefixed, which the API client will not
 * attach over plain http, so a request made that way arrives anonymous and
 * every assertion below would pass for the wrong reason. Going through the
 * page's own `fetch` is also exactly what the Blob SDK does.
 */
async function askForToken(
  page: Page,
  pathname: string,
  clientPayload: unknown,
): Promise<TokenAttempt> {
  return page.evaluate(
    async ([path, payload]) => {
      const response = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'blob.generate-client-token',
          payload: { pathname: path, clientPayload: payload, multipart: false },
        }),
      });
      return {
        status: response.status,
        body: (await response.text()).slice(0, 400),
        landedOn: new URL(response.url).pathname,
      };
    },
    [pathname, JSON.stringify(clientPayload)] as const,
  );
}

/**
 * Skip when the environment has no Blob token at all.
 *
 * Without one the route answers "storage is not configured" *before* it
 * reaches any of the authorisation below, so every assertion here would fail
 * on the wrong thing — or, worse, pass for the wrong reason. CI sets a dummy
 * token precisely so these run; a developer who has not pulled one down gets
 * a skip rather than a puzzle.
 */
async function skipWithoutStorage(page: Page, vehicleId: string) {
  const probe = await askForToken(page, `documents/vehicle/${vehicleId}/u-probe.pdf`, {
    vehicleId,
  });
  test.skip(
    probe.body.includes('storage is not configured'),
    'no BLOB_READ_WRITE_TOKEN in this environment',
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('document upload authorisation', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('signs a token for the record being uploaded to', async ({ page }) => {
    await signIn(page);
    const [vehicleId] = await twoVehicleIds(page);

    await skipWithoutStorage(page, vehicleId);

    const attempt = await askForToken(
      page,
      `documents/vehicle/${vehicleId}/11111111-1111-4111-8111-111111111111-mot.pdf`,
      { vehicleId },
    );

    expect(attempt.status).toBe(200);
    expect(attempt.body).toContain('clientToken');
  });

  test('refuses a pathname belonging to another record', async ({ page }) => {
    /*
     * The attack the whole route exists to stop. An operator has rights to
     * upload documents — that is their job — so the question is never whether
     * they may upload, it is whose folder they may upload into. Nothing but
     * this check stands between the two, because the file itself never comes
     * back through the application to be checked again.
     */
    await signIn(page);
    const [mine, theirs] = await twoVehicleIds(page);
    await skipWithoutStorage(page, mine);

    const attempt = await askForToken(
      page,
      `documents/vehicle/${theirs}/11111111-1111-4111-8111-111111111111-mot.pdf`,
      { vehicleId: mine },
    );

    expect(attempt.status).toBe(400);
    expect(attempt.body).toContain('does not belong');
    expect(attempt.body).not.toContain('clientToken');
  });

  test('refuses a pathname outside the documents prefix', async ({ page }) => {
    // Branding assets and everything else live elsewhere, and this token
    // would otherwise be a general-purpose write into the store.
    await signIn(page);
    const [vehicleId] = await twoVehicleIds(page);
    await skipWithoutStorage(page, vehicleId);

    const attempt = await askForToken(page, `branding/vehicle/${vehicleId}/logo.png`, {
      vehicleId,
    });

    expect(attempt.status).toBe(400);
    expect(attempt.body).not.toContain('clientToken');
  });

  test('refuses a payload naming both a driver and a vehicle', async ({ page }) => {
    await signIn(page);
    const [vehicleId] = await twoVehicleIds(page);
    await skipWithoutStorage(page, vehicleId);

    const attempt = await askForToken(page, `documents/vehicle/${vehicleId}/u-mot.pdf`, {
      vehicleId,
      driverId: 'drv_anything',
    });

    expect(attempt.status).toBe(400);
    expect(attempt.body).not.toContain('clientToken');
  });

  test('refuses a record that does not exist', async ({ page }) => {
    await signIn(page);
    const [vehicleId] = await twoVehicleIds(page);
    await skipWithoutStorage(page, vehicleId);

    const attempt = await askForToken(page, 'documents/vehicle/not-a-real-id/u-mot.pdf', {
      vehicleId: 'not-a-real-id',
    });

    expect(attempt.status).toBe(400);
    expect(attempt.body).not.toContain('clientToken');
  });

  test('refuses anyone who is not signed in', async ({ page, browser }) => {
    // Read the ids with a session, then ask without one.
    await signIn(page);
    const [vehicleId] = await twoVehicleIds(page);

    const anonymous = await browser.newContext();
    const stranger = await anonymous.newPage();
    // The login page, so the fetch below is same-origin and cookie-less.
    await stranger.goto('/login');

    const attempt = await askForToken(
      stranger,
      `documents/vehicle/${vehicleId}/u-mot.pdf`,
      { vehicleId },
    );
    await anonymous.close();

    /*
     * Bounced by the middleware before the handler runs, so this is a
     * redirect to the login page rather than a 401 from the route. Either
     * would be fine; what must never happen is a signed token.
     */
    expect(attempt.landedOn).toBe('/login');
    expect(attempt.body).not.toContain('clientToken');
  });
});
