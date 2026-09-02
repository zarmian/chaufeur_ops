import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * The passenger's page, opened the way a passenger opens it.
 *
 * The rules are unit-tested in `lib/tracking.test.ts` and the token handling
 * in `lib/tracking-store.integration.test.ts`. What only a browser can show is
 * the part that would be embarrassing rather than merely wrong: that the page
 * really does open with no session, that a forwarded link carries no price,
 * and that a dead link says something a passenger can act on instead of
 * offering them a dashboard they have no account for.
 *
 * The link is taken from the job screen rather than minted in the test,
 * because the panel an operator copies from is part of what is being checked.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

const RUN = uniqueDigits(6);

/**
 * A pickup a few hours from now, as the form's two fields.
 *
 * Inside the link's 24-hour window and comfortably in the future, whatever
 * time of day the suite runs. Booking "tomorrow" put the pickup *outside* the
 * window — the link had not opened yet — which is the rule working and the
 * test asking the wrong question.
 *
 * Formatted in the install's own timezone, because the form's time field is
 * local and the runner is not.
 */
function pickupSoon(): { date: string; time: string } {
  const at = new Date(Date.now() + 3 * 3_600_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Book a priced job and return the tracking path off its panel. */
async function bookAndGetTrackingPath(page: Page, pickup: string) {
  const when = pickupSoon();
  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(when.date);
  await page.getByLabel('Time').fill(when.time);
  await page.getByLabel('Pickup').fill(pickup);
  await page.getByLabel('Destination').fill('Heathrow Terminal 5');
  await page.getByLabel('Client price').fill('145.00');
  await page.getByRole('button', { name: 'Book job' }).click();

  const panel = page.getByTestId('tracking-panel');
  await expect(panel).toBeVisible();

  const href = await panel
    .getByRole('link', { name: 'Open it' })
    .getAttribute('href');
  expect(href).toMatch(/^\/track\/.+/);
  return href!;
}

test.describe('the passenger tracking page', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('opens with no session and carries nothing it should not', async ({
    browser,
  }) => {
    const staff = await browser.newContext();
    const staffPage = await staff.newPage();
    await signIn(staffPage);

    const pickup = `The Dorchester ${RUN}`;
    const path = await bookAndGetTrackingPath(staffPage, pickup);
    await staff.close();

    /*
     * A completely separate context — no cookies, nothing carried over. This
     * is the passenger, or whoever the link was forwarded to.
     */
    const passenger = await browser.newContext();
    const page = await passenger.newPage();

    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as unknown as { __csp: string[] }).__csp.push(
          event.violatedDirective,
        );
      });
    });

    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    // It answered without a session, which is the whole point.
    expect(await passenger.cookies()).toEqual([]);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(pickup)).toBeVisible();

    /*
     * The margin, which a forwarded link would hand to a competitor. Asserted
     * against the rendered HTML rather than the view model, because the page
     * is what actually reaches the passenger.
     */
    const html = await page.content();
    expect(html).not.toContain('145.00');
    expect(html).not.toContain('14500');

    // A public page carrying a policy violation is a page that has quietly
    // stopped working somewhere. The dashboard is covered in `csp.spec.ts`;
    // this route is not signed in, so it is checked here.
    expect(
      await page.evaluate(
        () => (window as unknown as { __csp: string[] }).__csp,
      ),
    ).toEqual([]);

    await passenger.close();
  });

  test('tells a passenger with a dead link who to ring, not to sign in', async ({
    browser,
  }) => {
    /*
     * The application's own not-found offers "Back to dashboard", which is
     * the wrong answer for somebody holding an expired link: they have no
     * account and no idea what a dashboard is.
     */
    const passenger = await browser.newContext();
    const page = await passenger.newPage();

    const response = await page.goto('/track/this-token-was-never-issued-abc');
    expect(response?.status()).toBe(404);

    await expect(page.getByText(/no longer available/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /dashboard/i })).toHaveCount(0);

    await passenger.close();
  });
});
