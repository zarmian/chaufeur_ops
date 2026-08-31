import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits, uniquePhone, uniquePlate } from './unique';

/**
 * Phase 2 acceptance, end to end.
 *
 * The three flows named in the definition of done, in the order they matter:
 * a job priced at booking goes all the way through; an unpriced job is
 * refused at completion until someone says why; and a driver with a lapsed
 * badge cannot be put on a job at all.
 *
 * These run against a real build and a real database. The pricing rules are
 * unit-tested exhaustively elsewhere — what only this proves is that the
 * rules are actually wired to the buttons an operator presses.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL ?? 'viewer@example.com';
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '' && VIEWER_PASSWORD !== '';

/** `YYYY-MM-DD`, N days from now — so fixtures never go stale. */
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

/** Create a compliant driver and vehicle, and return the driver's name. */
async function createCompliantDriver(page: Page, name: string) {
  const plate = uniquePlate('PH');

  await page.goto('/vehicles/new');
  await page.getByLabel('Registration').fill(plate);
  await page.getByLabel('Make').fill('Mercedes-Benz');
  await page.getByLabel('Model').fill('E-Class');
  await page.getByLabel('MOT expires').fill(dateIn(400));
  await page.getByLabel('Insurance expires').fill(dateIn(400));
  // All three dates, not just two: an unrecorded expiry counts as
  // non-compliant, so a vehicle missing its PHV licence date cannot be
  // assigned either.
  await page.getByLabel('PHV vehicle licence expires').fill(dateIn(400));
  await page.getByRole('button', { name: 'Add vehicle' }).click();
  await expect(page.getByRole('heading', { name: plate })).toBeVisible();

  await page.goto('/drivers/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Phone').fill(uniquePhone());
  await page.getByLabel('DVLA licence expires').fill(dateIn(400));
  await page.getByLabel('PHV badge expires').fill(dateIn(400));
  // Assigning the car matters: a job cannot reach ASSIGNED without both a
  // driver and a vehicle, and this is what makes the booking form fill the
  // vehicle in automatically when the driver is chosen.
  await selectByOptionText(page, '#assignedVehicleId', plate);
  await page.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  return { plate };
}

/**
 * Pick the option whose text contains `text`, by select id.
 *
 * Option labels carry generated references (`Name · DRV-0001`,
 * `AB12 CDE · Mercedes-Benz E-Class`) that the test cannot predict, so it
 * matches on the part it knows and selects by value. Ids rather than labels
 * because "Driver" also matches the "Driver price" field.
 */
async function selectByOptionText(page: Page, selectId: string, text: string) {
  const select = page.locator(selectId);
  const value = await select
    .locator('option', { hasText: text })
    .first()
    .getAttribute('value');
  expect(value, `no option matching ${text} in ${selectId}`).toBeTruthy();
  await select.selectOption(value!);
}

async function selectDriver(page: Page, driverName: string) {
  await selectByOptionText(page, '#driverId', driverName);
}

/**
 * Move the job to `label` and wait for it to land.
 *
 * A successful transition redirects, so the assertion has to be on the state
 * *after* the redirect — checking the select immediately would race it and
 * read the previous status's options.
 */
/**
 * Submit the status form and wait for the redirect to land.
 *
 * The wait is on the URL *changing*, not on it matching a pattern: every
 * outcome redirects with a query string, so after the first transition the
 * URL already matches and a pattern wait would return instantly, racing the
 * next navigation.
 */
async function submitStatus(page: Page, label: string) {
  const before = page.url();
  await page.locator('#status').selectOption({ label });
  await Promise.all([
    page.waitForURL((url) => url.toString() !== before, { timeout: 15_000 }),
    page.getByRole('button', { name: 'Update status' }).click(),
  ]);
}

async function moveStatus(page: Page, label: string) {
  await submitStatus(page, label);
  await expect(page.getByTestId('job-status')).toHaveText(label, {
    timeout: 15_000,
  });
}

/** Attempt a transition that is expected to be refused. */
async function attemptStatus(page: Page, label: string) {
  await submitStatus(page, label);
  await expect(page).toHaveURL(/[?&]statusError=/);
}

/** Fill the booking form's required fields. Price is left to the caller. */
async function fillBooking(
  page: Page,
  options: { pickup: string; dropoff: string; days?: number },
) {
  await page.getByLabel('Date').fill(dateIn(options.days ?? 3));
  await page.getByLabel('Time').fill('14:30');
  await page.getByLabel('Pickup').fill(options.pickup);
  await page.getByLabel('Destination').fill(options.dropoff);
}

test.describe('jobs', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('a job priced at booking runs through to completion', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const driverName = `Job Driver ${Date.now()}`;
    await createCompliantDriver(page, driverName);

    const pickup = `The Dorchester ${Date.now()}`;
    await page.goto('/jobs/new');
    await fillBooking(page, { pickup, dropoff: 'Heathrow Terminal 5' });

    // The price is on the form, not behind a modal. This is the requirement
    // the whole phase exists for.
    await page.getByLabel('Client price').fill('125.50');
    await page.getByLabel('Driver price').fill('80.00');

    await selectDriver(page, driverName);
    await page.getByRole('button', { name: 'Book job' }).click();

    // Lands on the detail page with a reference and no unpriced warning.
    await expect(page.getByTestId('unpriced-alert')).toHaveCount(0);
    await expect(page.getByText(pickup).first()).toBeVisible();

    // Walk the status through to completion.
    for (const status of ['Assigned', 'In progress', 'Completed']) {
      await moveStatus(page, status);
    }

    // The timeline records each step, which is what the legacy system could
    // never reconstruct.
    await expect(page.getByText('Job created')).toBeVisible();
    await expect(page.getByText('Assigned to driver')).toBeVisible();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();

    // And the booking price is on the record.
    await expect(page.getByText('£125.50').first()).toBeVisible();
  });

  test('an unpriced job is refused at completion until a reason is given', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const driverName = `Unpriced Driver ${Date.now()}`;
    await createCompliantDriver(page, driverName);

    await page.goto('/jobs/new');
    await fillBooking(page, {
      pickup: `Claridges ${Date.now()}`,
      dropoff: 'Gatwick North',
    });
    await selectDriver(page, driverName);

    // Saving without a price takes a deliberate second click.
    await expect(page.getByTestId('unpriced-warning')).toBeVisible();
    await expect(
      page.getByText("Jobs without prices don't appear in revenue reports"),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save without a price' }).click();
    await page.getByRole('button', { name: 'Book job' }).click();

    // The detail page says so, in red, without being asked.
    await expect(page.getByTestId('unpriced-alert')).toBeVisible();

    await moveStatus(page, 'Assigned');
    await moveStatus(page, 'In progress');

    // Completing is blocked, and the prompt offers the preset reasons.
    await page.locator('#status').selectOption({ label: 'Completed' });
    await expect(page.getByTestId('zero-value-prompt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Goodwill' })).toBeVisible();

    await page.getByRole('button', { name: 'Goodwill' }).click();
    await page.getByRole('button', { name: 'Update status' }).click();

    // With a reason recorded it goes through, and the reason is on the record.
    await expect(page.getByTestId('job-status')).toHaveText('Completed', {
      timeout: 15_000,
    });
    await expect(page.getByText('Goodwill').first()).toBeVisible();
  });

  test('a driver with a lapsed badge cannot be assigned, and it says why', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // A compliant vehicle, so the only defect is the badge. Without one the
    // "needs a vehicle" check fires first — correctly, but that is a
    // different rule from the one under test.
    const plate = uniquePlate('LB');
    await page.goto('/vehicles/new');
    await page.getByLabel('Registration').fill(plate);
    await page.getByLabel('Make').fill('Mercedes-Benz');
    await page.getByLabel('Model').fill('E-Class');
    await page.getByLabel('MOT expires').fill(dateIn(400));
    await page.getByLabel('Insurance expires').fill(dateIn(400));
    await page.getByLabel('PHV vehicle licence expires').fill(dateIn(400));
    await page.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(page.getByRole('heading', { name: plate })).toBeVisible();

    const driverName = `Lapsed Badge ${Date.now()}`;
    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(driverName);
    await page.getByLabel('Phone').fill(uniquePhone());
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(-10));
    await page.getByRole('button', { name: 'Add driver' }).click();
    await expect(page.getByRole('heading', { name: driverName })).toBeVisible();

    await page.goto('/jobs/new');
    await fillBooking(page, {
      pickup: `The Savoy ${Date.now()}`,
      dropoff: 'London City Airport',
    });
    await page.getByLabel('Client price').fill('95.00');
    await selectDriver(page, driverName);
    await selectByOptionText(page, '#vehicleId', plate);
    await page.getByRole('button', { name: 'Book job' }).click();

    // The detail page warns before anyone tries.
    await expect(page.getByTestId('compliance-alert')).toBeVisible();
    // Asserting the document, not the day count: the count depends on what "today"
    // is in the configured timezone, and this test can run either side of midnight.
    await expect(page.getByText(/PHV badge expired/)).toBeVisible();

    // And assignment is actually refused, naming the document.
    await attemptStatus(page, 'Assigned');

    const error = page.getByTestId('status-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText(/PHV badge/i);
  });

  test('the list shows a No price badge and an unpriced count', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Creates its own unpriced job rather than relying on seeded volume or on
    // another test having run first — the suite runs in parallel.
    const pickup = `Unpriced List ${Date.now()}`;
    await page.goto('/jobs/new');
    await fillBooking(page, { pickup, dropoff: 'Luton Airport' });
    await page.getByRole('button', { name: 'Save without a price' }).click();
    await page.getByRole('button', { name: 'Book job' }).click();
    await expect(page.getByTestId('unpriced-alert')).toBeVisible();

    await page.goto(`/jobs?unpriced=true&all=true&q=${encodeURIComponent(pickup)}`);

    await expect(page.getByTestId('unpriced-badge').first()).toBeVisible();
    await expect(page.getByText(/\d+ unpriced/).first()).toBeVisible();
  });

  test('filter state survives a reload, so a view can be shared', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // The requirement is that the whole view lives in the URL (spec 2.2.8):
    // the legacy Overview kept its search in memory and lost it on refresh.
    // Asserted on the controls rather than on rows, because other tests
    // running in parallel are creating jobs the whole time.
    await page.goto(
      '/jobs?all=true&status=COMPLETED&jobType=TRANSFER&sort=reference&dir=desc&q=Heathrow',
    );

    await expect(page.locator('#status')).toHaveValue('COMPLETED');
    await expect(page.locator('#jobType')).toHaveValue('TRANSFER');
    await expect(page.locator('#q')).toHaveValue('Heathrow');

    await page.reload();

    await expect(page.locator('#status')).toHaveValue('COMPLETED');
    await expect(page.locator('#jobType')).toHaveValue('TRANSFER');
    await expect(page.locator('#q')).toHaveValue('Heathrow');
    await expect(page).toHaveURL(/sort=reference/);
    await expect(page).toHaveURL(/dir=desc/);
  });

  test('an as-directed job totals hourly work, a stop and a recharged expense', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const pickup = `As Directed ${Date.now()}`;
    await page.goto('/jobs/new');
    await page.locator('#jobType').selectOption('AS_DIRECTED');
    await page.getByLabel('Date').fill(dateIn(5));
    await page.getByLabel('Time').fill('09:00');
    await page.getByLabel('Pickup').fill(pickup);
    await page.getByLabel('Destination').fill('As directed');

    // Two hours booked against a four-hour minimum bills four.
    await page.locator('#customerHours').fill('2');
    await page.locator('#customerRate').fill('45.00');
    await page.locator('#minimumHours').fill('4');
    await expect(page.getByTestId('hourly-total')).toContainText('£180.00');
    await expect(page.getByTestId('hourly-total')).toContainText('minimum applied');

    // A stop with its own charge, which is revenue on top of the hourly work.
    await page.getByRole('button', { name: 'Add a stop' }).click();
    await page.locator('input[name="stopAddress"]').fill('The Ritz');
    await page.locator('input[name="stopWait"]').fill('20');
    await page.locator('input[name="stopCharge"]').fill('15.00');

    await page.getByRole('button', { name: 'Book job' }).click();
    await expect(page.getByText('The Ritz')).toBeVisible();

    // £180 hourly plus the £15 stop.
    await expect(page.getByText('£195.00').first()).toBeVisible();

    // A congestion charge recharged to the client is revenue too.
    await page.locator('#kind').selectOption('CONGESTION_CHARGE');
    await page.locator('#amount').fill('15.00');
    await page.locator('#borneBy').selectOption('CLIENT');
    await Promise.all([
      page.waitForURL(/[?&](updated|expenseError)=/, { timeout: 15_000 }),
      page.getByRole('button', { name: 'Add' }).click(),
    ]);

    await expect(page.getByTestId('expenses-panel')).toContainText(
      'Congestion charge',
    );
    await expect(page.getByText('Recharged').first()).toBeVisible();
    await expect(page.getByText('£210.00').first()).toBeVisible();

    // **And it is a priced job**, which is where this test used to stop.
    //
    // Every figure above was right while the same page flew the unpriced
    // alert and refused completion, because the checks read only
    // `clientPricePence` — null here, since an as-directed job carries its
    // total on the finance record. All 24 hourly jobs on the deployment were
    // stuck, and invoicing draws on completed jobs, so none could be billed.
    // The suite passed throughout precisely because it never tried.
    await expect(page.getByTestId('unpriced-alert')).toHaveCount(0);
  });

  test('an as-directed job can be completed and invoiced', async ({ page }) => {
    // The other half: a full hourly job walked to COMPLETED and then offered
    // for billing at the total it was quoted at.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const pickup = `Hourly End To End ${uniqueDigits(6)}`;
    const driverName = `Hourly Driver ${uniqueDigits(6)}`;
    const plate = uniquePlate('HR');

    await page.goto('/vehicles/new');
    await page.getByLabel('Registration').fill(plate);
    await page.getByLabel('Make').fill('Mercedes-Benz');
    await page.getByLabel('Model').fill('V-Class');
    await page.getByLabel('MOT expires').fill(dateIn(400));
    await page.getByLabel('Insurance expires').fill(dateIn(400));
    await page.getByLabel('PHV vehicle licence expires').fill(dateIn(400));
    await page.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(page.getByRole('heading', { name: plate })).toBeVisible();

    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(driverName);
    await page.getByLabel('Phone').fill(uniquePhone());
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(400));
    await selectByOptionText(page, '#assignedVehicleId', plate);
    await page.getByRole('button', { name: 'Add driver' }).click();
    await expect(page.getByRole('heading', { name: driverName })).toBeVisible();

    // Four hours at £59 — the shape from the defect report.
    await page.goto('/jobs/new');
    await page.locator('#jobType').selectOption('AS_DIRECTED');
    await page.getByLabel('Date').fill(dateIn(4));
    await page.getByLabel('Time').fill('09:00');
    await page.getByLabel('Pickup').fill(pickup);
    await page.getByLabel('Destination').fill('As directed');
    await page.locator('#customerHours').fill('4');
    await page.locator('#customerRate').fill('59.00');
    await selectByOptionText(page, '#driverId', driverName);
    await page.getByRole('button', { name: 'Book job' }).click();
    await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 20_000 });

    const jobUrl = page.url();
    await expect(page.getByTestId('unpriced-alert')).toHaveCount(0);
    await expect(page.getByText('£236.00').first()).toBeVisible();

    for (const next of ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED']) {
      await page.goto(jobUrl);
      const control = page.locator('select[name="status"]').first();
      await expect(control).toBeVisible();
      await control.selectOption(next);
      await Promise.all([
        page.waitForURL(/[?&](updated|statusError)=/, { timeout: 20_000 }),
        page.getByRole('button', { name: /Update|Change|Move/ }).first().click(),
      ]);
      // A refusal names the price; catching it here says which step failed.
      await expect(
        page.getByText(/no client price/i),
        `refused at ${next}`,
      ).toHaveCount(0);
    }

    await page.goto(jobUrl);
    await expect(page.getByTestId('job-status')).toContainText(/completed/i);

    // And it reaches the billing screen at the figure it was quoted at.
    await page.goto(`/invoices/new?from=2020-01-01&to=${dateIn(30)}`);
    /*
     * The row is found by its pickup, which is unique to this run, and the
     * figure is asserted *inside that row*. An earlier version matched either
     * the pickup or the total anywhere on the page, which was two mistakes at
     * once: `.or()` resolves to two elements when both halves match and fails
     * strict mode outright — this assertion has been red since it was written
     * — and even had it passed, a £236.00 belonging to somebody else's job
     * would have satisfied it.
     */
    const billingRow = page.getByRole('row').filter({ hasText: pickup });
    await expect(billingRow).toHaveCount(1);
    await expect(billingRow).toContainText('£236.00');
  });

  test('an expense the driver bears is neither revenue nor cost', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/jobs/new');
    await fillBooking(page, {
      pickup: `Driver Borne ${Date.now()}`,
      dropoff: 'Heathrow T5',
    });
    await page.getByLabel('Client price').fill('100.00');
    await page.getByRole('button', { name: 'Book job' }).click();
    await expect(page.getByTestId('expenses-panel')).toBeVisible();

    await page.locator('#kind').selectOption('FUEL');
    await page.locator('#amount').fill('40.00');
    await page.locator('#borneBy').selectOption('DRIVER');
    await Promise.all([
      page.waitForURL(/[?&](updated|expenseError)=/, { timeout: 15_000 }),
      page.getByRole('button', { name: 'Add' }).click(),
    ]);

    // Counting it would understate profit on every owner-driver job.
    await expect(page.getByText("Driver's cost")).toBeVisible();
    await expect(page.getByText('£100.00').first()).toBeVisible();
  });

  test('a VIEWER cannot reach the booking form or change a status', async ({
    page,
  }) => {
    await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);

    // Reading the list is fine — it is information.
    await page.goto('/jobs?all=true');
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();

    // Booking is not.
    await page.goto('/jobs/new');
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Book job' })).toHaveCount(0);
  });
});
