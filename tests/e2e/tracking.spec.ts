import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits, uniquePhone, uniquePlate } from './unique';

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
 * Comfortably in the future, whatever time of day the suite runs. Three hours
 * is deliberately *outside* the two-hour window in which the driver and the
 * car appear, so this one exercises the page before the crew is shown;
 * `pickupImminent` below is the other side of that line.
 *
 * Formatted in the install's own timezone, because the form's time field is
 * local and the runner is not.
 */
function pickupSoon(): { date: string; time: string } {
  return asFormFields(new Date(Date.now() + 3 * 3_600_000));
}

/** A pickup inside the two-hour window, where the crew and the box appear. */
function pickupImminent(): { date: string; time: string } {
  return asFormFields(new Date(Date.now() + 80 * 60_000));
}

function asFormFields(at: Date): { date: string; time: string } {
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

/** A compliant driver with a car, so a job can be taken to completion. */
async function createCompliantDriver(page: Page, name: string) {
  const plate = uniquePlate('TK');
  const dateIn = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  };

  await page.goto('/vehicles/new');
  await page.getByLabel('Registration').fill(plate);
  await page.getByLabel('Make').fill('Mercedes-Benz');
  await page.getByLabel('Model').fill('S-Class');
  await page.getByLabel('MOT expires').fill(dateIn(400));
  await page.getByLabel('Insurance expires').fill(dateIn(400));
  await page.getByLabel('PHV vehicle licence expires').fill(dateIn(400));
  await page.getByRole('button', { name: 'Add vehicle' }).click();
  await expect(page.getByRole('heading', { name: plate })).toBeVisible();

  await page.goto('/drivers/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Phone').fill(uniquePhone());
  await page.getByLabel('DVLA licence expires').fill(dateIn(400));
  await page.getByLabel('PHV badge expires').fill(dateIn(400));
  const vehicleOption = await page
    .locator('#assignedVehicleId option', { hasText: plate })
    .first()
    .getAttribute('value');
  await page.locator('#assignedVehicleId').selectOption(vehicleOption!);
  await page.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** Book a priced job and return the tracking path off its panel. */
async function bookAndGetTrackingPath(
  page: Page,
  pickup: string,
  when: { date: string; time: string } = pickupSoon(),
  driverName?: string,
) {
  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(when.date);
  await page.getByLabel('Time').fill(when.time);
  await page.getByLabel('Pickup').fill(pickup);
  await page.getByLabel('Destination').fill('Heathrow Terminal 5');
  await page.getByLabel('Client price').fill('145.00');
  if (driverName) {
    const value = await page
      .locator('#driverId option', { hasText: driverName })
      .first()
      .getAttribute('value');
    await page.locator('#driverId').selectOption(value!);
  }
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


  test('holds the crew back until two hours before, then shows them', async ({
    browser,
  }) => {
    /*
     * The rule the page was rebuilt around. A link sent at booking has to
     * work — a client who taps it and gets a 404 does not tap the next one —
     * but until two hours out it says a car is booked and nothing about who
     * is driving it. The crew can still change, and the fewer hours an
     * owner-driver's name sits in a forwarded group chat the better.
     */
    const staff = await browser.newContext();
    const staffPage = await staff.newPage();
    await signIn(staffPage);

    const early = await bookAndGetTrackingPath(
      staffPage,
      `Early ${RUN}`,
      pickupSoon(),
    );
    const imminent = await bookAndGetTrackingPath(
      staffPage,
      `Imminent ${RUN}`,
      pickupImminent(),
    );
    await staff.close();

    const passenger = await browser.newContext();
    const page = await passenger.newPage();

    // Three hours out: answers, but says nothing about a driver or a car.
    expect((await page.goto(early))?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('tracking-car')).toHaveCount(0);
    await expect(page.getByText(/two hours before/i).first()).toBeVisible();

    // Eighty minutes out: the section exists. Whether it names anybody
    // depends on a driver being assigned, which this booking has not done —
    // what is being asserted is that the window, not the page, was the gate.
    expect((await page.goto(imminent))?.status()).toBe(200);
    await expect(page.getByText(/two hours before/i)).toHaveCount(0);

    await passenger.close();
  });

  test('closes the link the moment the journey is finished', async ({
    browser,
  }) => {
    /*
     * A tracking link is not a receipt. Once the passenger is set down it is
     * a page naming a driver, a car and two addresses sitting in whatever
     * chat it was forwarded into — so the driver tapping Completed is what
     * shuts it, and the thread on it goes too.
     */
    const staff = await browser.newContext();
    const staffPage = await staff.newPage();
    await signIn(staffPage);

    const driverName = `Finisher ${RUN}`;
    await createCompliantDriver(staffPage, driverName);

    const path = await bookAndGetTrackingPath(
      staffPage,
      `Finishing ${RUN}`,
      pickupImminent(),
      driverName,
    );
    const jobUrl = staffPage.url();

    const passenger = await browser.newContext();
    const page = await passenger.newPage();
    expect((await page.goto(path))?.status()).toBe(200);

    /*
     * Marked complete from the office, which is what a driver's tap does.
     * Through the status form rather than the bot, because the rule being
     * tested is about the job's status and not about how it got there.
     */
    await staffPage.goto(jobUrl);
    for (const label of ['Assigned', 'In progress', 'Completed']) {
      const before = staffPage.url();
      await staffPage.locator('#status').selectOption({ label });
      await Promise.all([
        staffPage.waitForURL((url) => url.toString() !== before, {
          timeout: 15_000,
        }),
        staffPage.getByRole('button', { name: 'Update status' }).click(),
      ]);
    }
    await expect(staffPage.getByTestId('job-status')).toHaveText('Completed');

    const after = await page.goto(path);
    expect(after?.status()).toBe(404);
    await expect(page.getByText(/no longer available/i)).toBeVisible();

    await staff.close();
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
