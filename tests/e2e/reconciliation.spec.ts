import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits, uniquePhone, uniquePlate } from './unique';

/**
 * Phase 4.8 acceptance, end to end.
 *
 * The walk this proves is the one the operator described: a CSV from the bank
 * goes in, the system works out which invoices the money settles, shows that
 * before writing anything, and — once confirmed — the invoices read paid and
 * the payments are there.
 *
 * The allocation arithmetic and the parsing are unit-tested to death. What
 * only this can prove is that the proposal on the screen is the one that gets
 * applied, and that Undo actually puts it all back.
 *
 * The second half covers address search: with no provider configured the
 * field still completes UK postcodes, and the postcode lands on the job.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/** Unique per run, so two runs never collide on a fingerprint. */
const RUN = uniqueDigits(7);
const PAYER = `Kettleby Chambers ${RUN}`;

function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `DD/MM/YYYY`, as a UK bank writes it. */
function ukDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('/');
}

function pence(text: string): number {
  const digits = text.replace(/[^0-9.]/g, '');
  return Math.round(Number(digits) * 100);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

async function selectByOptionText(page: Page, selectId: string, text: string) {
  const select = page.locator(selectId);
  const value = await select
    .locator('option', { hasText: text })
    .first()
    .getAttribute('value');
  expect(value, `no option matching ${text} in ${selectId}`).toBeTruthy();
  await select.selectOption(value!);
}

/**
 * Upload a statement through the real screen.
 *
 * `setInputFiles` with a buffer rather than a fixture on disk, so the run's
 * unique payer name reaches the CSV — two runs sharing a description would
 * share a fingerprint, and the second import would find nothing new.
 */
async function importStatement(page: Page, rows: string[]) {
  await page.goto('/reconciliation/import');

  await page.locator('#statement').setInputFiles({
    name: `statement-${RUN}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(['Date,Amount,Memo', ...rows].join('\n'), 'utf8'),
  });

  // 4.8.1.6 — the preview arrives before anything is written.
  const confirm = page.getByRole('button', { name: /Import \d+ transaction/ });
  await expect(confirm).toBeVisible({ timeout: 15_000 });

  await Promise.all([
    page.waitForURL(/\/reconciliation\?/, { timeout: 20_000 }),
    confirm.click(),
  ]);
}


async function submitStatus(page: Page, label: string) {
  const before = page.url();
  await page.locator('#status').selectOption({ label });
  await Promise.all([
    page.waitForURL((url) => url.toString() !== before, { timeout: 15_000 }),
    page.getByRole('button', { name: 'Update status' }).click(),
  ]);
}

/**
 * A driver with a compliant car.
 *
 * A job cannot reach `ASSIGNED` without one and cannot reach `COMPLETED`
 * without passing through it, and only a completed job can be invoiced — so
 * the reconciliation walk has to start here.
 */
async function createCompliantDriver(page: Page, name: string) {
  const plate = uniquePlate('RC');

  await page.goto('/vehicles/new');
  await page.getByLabel('Registration').fill(plate);
  await page.getByLabel('Make').fill('Mercedes-Benz');
  await page.getByLabel('Model').fill('E-Class');
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
  await selectByOptionText(page, '#assignedVehicleId', plate);
  await page.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** A completed, priced job dated a few days ago, for `clientName`. */
async function completedJob(
  page: Page,
  clientName: string,
  driverName: string,
  price: string,
) {
  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(dateIn(-2));
  await page.getByLabel('Time').fill('09:15');
  await page.getByLabel('Pickup').fill(`Mayfair ${Date.now()}`);
  await page.getByLabel('Destination').fill('Heathrow Terminal 5');
  await page.getByLabel('Client price').fill(price);
  await selectByOptionText(page, '#clientId', clientName);
  await selectByOptionText(page, '#driverId', driverName);
  await page.getByRole('button', { name: 'Book job' }).click();

  const refusal = page.getByTestId('form-error');
  if ((await refusal.count()) > 0) {
    throw new Error(`Booking refused: ${await refusal.innerText()}`);
  }
  await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 15_000 });

  for (const status of ['Assigned', 'In progress', 'Completed']) {
    await submitStatus(page, status);
  }
  await expect(page.getByTestId('job-status')).toHaveText('Completed', {
    timeout: 15_000,
  });
}

/**
 * Raise and send an invoice for whatever of `clientName`'s work is unbilled.
 *
 * Called twice: the first raise bills the first job, so the second finds only
 * the second — which is how two invoices of different ages end up against the
 * same payer without the test having to know any invoice numbers in advance.
 */
async function raiseAndSend(page: Page, clientName: string): Promise<string> {
  const window = `from=${dateIn(-30)}&to=${dateIn(1)}`;
  await page.goto(`/invoices/new?${window}`);

  const clientId = await page
    .locator('#clientId option', { hasText: clientName })
    .first()
    .getAttribute('value');
  expect(clientId, `no client option matching ${clientName}`).toBeTruthy();

  await page.goto(`/invoices/new?${window}&clientId=${clientId}`);
  await selectByOptionText(page, '#recipientClientId', clientName);
  await page.getByRole('button', { name: 'Raise draft invoice' }).click();
  await expect(page).toHaveURL(/\/invoices\/[^/?]+\?/, { timeout: 20_000 });

  const url = page.url();
  await Promise.all([
    page.waitForURL((next) => next.toString() !== url, { timeout: 30_000 }),
    page.getByRole('button', { name: 'Send' }).first().click(),
  ]);

  const heading = await page.getByRole('heading', { level: 1 }).first().textContent();
  return (heading ?? '').trim();
}

test.describe.configure({ mode: 'serial' });

test.describe('reconciliation', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  let invoiceNumbers: string[] = [];

  test('a statement previews before it is imported', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // A client whose name the bank reference will carry, so the credit
    // attributes itself with nobody choosing.
    await page.goto('/clients/new');
    await page.locator('#name').fill(PAYER);
    await page.getByRole('button', { name: 'Create client' }).click();
    await expect(page.getByRole('heading', { name: PAYER })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto('/reconciliation/import');
    await page.locator('#statement').setInputFiles({
      name: 'preview.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        ['Date,Amount,Memo', `${ukDate(-3)},250.00,${PAYER} FPS`].join('\n'),
        'utf8',
      ),
    });

    // 4.8.1.6 — the count of rows in each state, before anything is written.
    await expect(page.getByRole('button', { name: /Import 1 transaction/ })).toBeVisible({
      timeout: 15_000,
    });

    // And nothing was: the list does not have it.
    await page.goto(`/reconciliation?q=${encodeURIComponent(PAYER)}`);
    await expect(page.getByRole('cell', { name: new RegExp(PAYER) })).toHaveCount(0);
  });

  test('a payment clears invoices oldest first, and Undo puts them back', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const driverName = `${PAYER} Driver`;
    await createCompliantDriver(page, driverName);

    // £300 and £600 of work becomes £360 and £720 with VAT. A £700 credit
    // clears the first and leaves £380 owing on the second.
    invoiceNumbers = [];
    await completedJob(page, PAYER, driverName, '300.00');
    invoiceNumbers.push(await raiseAndSend(page, PAYER));

    await completedJob(page, PAYER, driverName, '600.00');
    invoiceNumbers.push(await raiseAndSend(page, PAYER));

    await importStatement(page, [`${ukDate(-1)},700.00,${PAYER} BACS CREDIT`]);

    await page.goto(`/reconciliation?q=${encodeURIComponent(PAYER)}&state=unallocated`);
    await page.getByRole('link', { name: /BACS CREDIT/ }).first().click();
    await expect(page).toHaveURL(/\/reconciliation\/[^/]+$/, { timeout: 15_000 });

    // 4.8.3.4 — the proposal says exactly what would happen, before it does.
    await expect(page.getByText('What this would settle')).toBeVisible();
    await expect(page.getByText('Part paid').first()).toBeVisible();

    const url = page.url();
    await Promise.all([
      page.waitForURL((next) => next.toString() !== url, { timeout: 20_000 }),
      page.getByRole('button', { name: 'Confirm' }).click(),
    ]);

    // The ledger reads as the proposal promised.
    await page.goto(`/invoices?q=${encodeURIComponent(invoiceNumbers[1]!)}`);
    const outstanding = await page
      .getByRole('row')
      .filter({ hasText: invoiceNumbers[1]! })
      .locator('td')
      .nth(6)
      .textContent();
    expect(pence(outstanding ?? '')).toBe(38_000);

    // 4.8.3.6 — undoing puts every one of them back.
    await page.goto(`/reconciliation?q=${encodeURIComponent(PAYER)}&state=allocated`);
    await page.getByRole('link', { name: /BACS CREDIT/ }).first().click();

    const before = page.url();
    await Promise.all([
      page.waitForURL((next) => next.toString() !== before, { timeout: 20_000 }),
      page.getByRole('button', { name: 'Undo' }).click(),
    ]);

    await page.goto(`/invoices?q=${encodeURIComponent(invoiceNumbers[1]!)}`);
    const restored = await page
      .getByRole('row')
      .filter({ hasText: invoiceNumbers[1]! })
      .locator('td')
      .nth(6)
      .textContent();
    expect(pence(restored ?? '')).toBe(72_000);
  });

  test('re-importing the same statement imports nothing twice', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const row = `${ukDate(-5)},41.00,${PAYER} REPEATED`;
    await importStatement(page, [row]);

    await page.goto('/reconciliation/import');
    await page.locator('#statement').setInputFiles({
      name: 'again.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(['Date,Amount,Memo', row].join('\n'), 'utf8'),
    });

    // What an operator does when they are not sure last week's upload worked.
    await expect(page.getByText('already imported')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: 'Nothing new to import' }),
    ).toBeDisabled();
  });

  test('an unmatched line stays unclassified rather than being guessed', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await importStatement(page, [`${ukDate(-2)},-17.40,QRZ MISC ${RUN}`]);

    await page.goto(`/reconciliation?q=${encodeURIComponent(`QRZ MISC ${RUN}`)}`);
    await expect(page.getByText('Unclassified').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the unreconciled total is on the screen', async ({ page }) => {
    // 4.8.5.4 — the number that answers "are the books straight".
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/reconciliation');
    await expect(page.getByText('Unreconciled')).toBeVisible();
  });
});

test.describe('address search', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  const LABEL = `Kettleby House ${RUN}`;
  const POSTCODE = 'W1K 1QA';

  /**
   * A saved location rather than a live provider.
   *
   * Deliberate. `postcodes.io` is a third-party service and Google needs a
   * key, so a test depending on either is a test that goes red for reasons
   * that have nothing to do with this code. The saved path is the one that
   * has to work on every install regardless of configuration — spec 4.8.6.3
   * and 4.8.6.6 — and it exercises the same field, the same endpoint and the
   * same hidden inputs.
   */
  test.beforeAll(async ({ browser }) => {
    if (!CREDENTIALS_SET) return;
    const page = await browser.newPage();
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/settings/pricing/locations');
    await page.locator('[data-testid="location-form"] [name="label"]').fill(LABEL);
    await page
      .locator('[data-testid="location-form"] [name="address"]')
      .fill('53 Park Lane, London');
    await page.locator('[data-testid="location-form"] [name="postcode"]').fill(POSTCODE);
    await page.getByRole('button', { name: 'Add location' }).click();
    await expect(page.getByText(LABEL).first()).toBeVisible({ timeout: 15_000 });

    await page.close();
  });

  test('a chosen suggestion puts its postcode on the job', async ({ page }) => {
    // 4.8.6.5. The hidden postcode is what prices the job; the text alone
    // never could.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/jobs/new');
    await page.getByLabel('Pickup').fill(LABEL.slice(0, 18));

    const suggestions = page.getByTestId('pickupText-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 15_000 });
    await suggestions.getByRole('option', { name: new RegExp(LABEL) }).first().click();

    await expect
      .poll(() => page.locator('input[name="pickupTextPostcode"]').inputValue(), {
        timeout: 10_000,
      })
      .toBe(POSTCODE);
  });

  test('typing over a chosen address clears what it resolved', async ({ page }) => {
    // An address reading "Heathrow T5" while carrying the Dorchester's
    // postcode is worse than one carrying nothing.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/jobs/new');
    const hidden = page.locator('input[name="pickupTextPostcode"]');

    await page.getByLabel('Pickup').fill(LABEL.slice(0, 18));
    const suggestions = page.getByTestId('pickupText-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 15_000 });
    await suggestions.getByRole('option', { name: new RegExp(LABEL) }).first().click();
    await expect.poll(() => hidden.inputValue(), { timeout: 10_000 }).toBe(POSTCODE);

    await page.getByLabel('Pickup').fill('Somewhere else entirely');
    await expect(hidden).toHaveValue('');
  });

  test('the postcode reaches the saved job', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/jobs/new');
    await page.getByLabel('Pickup').fill(LABEL.slice(0, 18));
    const suggestions = page.getByTestId('pickupText-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 15_000 });
    await suggestions.getByRole('option', { name: new RegExp(LABEL) }).first().click();
    await expect
      .poll(() => page.locator('input[name="pickupTextPostcode"]').inputValue(), {
        timeout: 10_000,
      })
      .toBe(POSTCODE);

    await page.getByLabel('Destination').fill(`Heathrow T5 ${RUN}`);
    await page.locator('#scheduledDate').fill(dateIn(4));
    await page.locator('#scheduledTime').fill('11:30');
    await page.locator('#clientPrice').fill('140.00');

    await Promise.all([
      page.waitForURL(/\/jobs\/[^/]+$/, { timeout: 30_000 }),
      page.getByRole('button', { name: /Book|Create/ }).first().click(),
    ]);

    // The job carries the postcode, which is what spec 4.8.6.7 needs for the
    // zone to resolve.
    await expect(page.getByText(POSTCODE).first()).toBeVisible({ timeout: 15_000 });
  });

  test('a booking still works with the address typed by hand', async ({ page }) => {
    // The field must never become a requirement. Address search is a help.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/jobs/new');
    await page.getByLabel('Pickup').fill(`Manual Pickup ${RUN}`);
    await page.getByLabel('Destination').fill(`Manual Destination ${RUN}`);
    await page.locator('#scheduledDate').fill(dateIn(3));
    await page.locator('#scheduledTime').fill('09:15');
    await page.locator('#clientPrice').fill('125.50');

    await Promise.all([
      page.waitForURL(/\/jobs\/[^/]+$/, { timeout: 30_000 }),
      page.getByRole('button', { name: /Book|Create/ }).first().click(),
    ]);

    await expect(page.getByText(`Manual Pickup ${RUN}`).first()).toBeVisible();
  });
});
