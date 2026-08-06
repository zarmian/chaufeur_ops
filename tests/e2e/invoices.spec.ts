import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4.3 and 4.4 acceptance, end to end.
 *
 * The legacy system generated invoices and then lost track of them. The walk
 * this proves is the whole of that gap: a completed job becomes an invoice,
 * the invoice becomes a document that locks when sent, a payment against it
 * moves the status, and both the ledger and the aging report agree with what
 * happened.
 *
 * The arithmetic and the numbering are tested elsewhere. What only this can
 * prove is that they are wired to the buttons an operator presses.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

/** `YYYY-MM-DD`, N days from now — so fixtures never go stale. */
function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Pence from a rendered `£1,234.56`, sign included. */
function pence(text: string): number {
  const negative = text.trim().startsWith('-');
  const digits = text.replace(/[^0-9.]/g, '');
  return Math.round(Number(digits) * 100) * (negative ? -1 : 1);
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

async function submitStatus(page: Page, label: string) {
  const before = page.url();
  await page.locator('#status').selectOption({ label });
  await Promise.all([
    page.waitForURL((url) => url.toString() !== before, { timeout: 15_000 }),
    page.getByRole('button', { name: 'Update status' }).click(),
  ]);
}

/**
 * Open the new-invoice screen showing only one client's unbilled work.
 *
 * 4.3.1 — filtered by client and date range. The test needs it for the same
 * reason an operator does: the period holds whatever else is in the database,
 * and an invoice carrying somebody else's work is the exact defect 4.3.5
 * exists to stop.
 */
async function billableFor(page: Page, clientName: string) {
  const window = `from=${dateIn(-30)}&to=${dateIn(1)}`;
  await page.goto(`/invoices/new?${window}`);

  const clientId = await page
    .locator('#clientId option', { hasText: clientName })
    .first()
    .getAttribute('value');
  expect(clientId, `no client option matching ${clientName}`).toBeTruthy();

  await page.goto(`/invoices/new?${window}&clientId=${clientId}`);
  await selectByOptionText(page, '#recipientClientId', clientName);
}

/**
 * A driver with a compliant car, because a job cannot reach `ASSIGNED`
 * without one and cannot reach `COMPLETED` without passing through it.
 */
async function createCompliantDriver(page: Page, name: string) {
  const plate = `IN${String(Date.now()).slice(-5)}`;

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
  await page.getByLabel('Phone').fill(`0770091${String(Date.now()).slice(-4)}`);
  await page.getByLabel('DVLA licence expires').fill(dateIn(400));
  await page.getByLabel('PHV badge expires').fill(dateIn(400));
  await selectByOptionText(page, '#assignedVehicleId', plate);
  await page.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/**
 * A completed, priced job dated a few days ago.
 *
 * Backdated rather than future-dated: the invoice screen bills what has
 * happened, and a job scheduled next week has not.
 */
async function completedJob(page: Page, clientName: string, price: string) {
  await page.goto('/clients/new');
  await page.getByLabel('Name').fill(clientName);
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();

  const driverName = `${clientName} Driver`;
  await createCompliantDriver(page, driverName);

  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(dateIn(-2));
  await page.getByLabel('Time').fill('09:15');
  await page.getByLabel('Pickup').fill(`Mayfair ${Date.now()}`);
  await page.getByLabel('Destination').fill('Heathrow Terminal 5');
  await page.getByLabel('Client price').fill(price);
  await selectByOptionText(page, '#clientId', clientName);
  await selectByOptionText(page, '#driverId', driverName);
  await page.getByRole('button', { name: 'Book job' }).click();

  // If the booking was refused, say why rather than timing out on the job
  // page that never loaded — a bare "element not found" is unreadable.
  const refusal = page.getByTestId('form-error');
  if ((await refusal.count()) > 0) {
    throw new Error(`Booking refused: ${await refusal.innerText()}`);
  }

  // Waited on the job's own status control, not on the absence of a
  // warning: `toHaveCount(0)` passes on any page, including the booking
  // form the browser has not left yet.
  try {
    await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 15_000 });
  } catch {
    const messages = await page.locator('[role="alert"], .text-destructive').allInnerTexts();
    throw new Error(
      `Booking did not land. url=${page.url()} messages=${JSON.stringify(messages)}`,
    );
  }
  await expect(page.getByTestId('unpriced-alert')).toHaveCount(0);

  for (const status of ['Assigned', 'In progress', 'Completed']) {
    await submitStatus(page, status);
  }
  await expect(page.getByTestId('job-status')).toHaveText('Completed', {
    timeout: 15_000,
  });
}

test.describe('invoicing', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('a completed job becomes an invoice, is paid, and reconciles', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const clientName = `Invoice Client ${Date.now()}`;
    await completedJob(page, clientName, '125.50');

    await billableFor(page, clientName);
    await page.getByRole('button', { name: 'Raise draft invoice' }).click();
    await expect(page).toHaveURL(/\/invoices\/[^/?]+\?/);

    // Server-side arithmetic: net from the job, VAT at the configured rate.
    await expect(page.getByText('£125.50').first()).toBeVisible();
    await expect(page.getByText('£25.10').first()).toBeVisible();
    await expect(page.getByText('£150.60').first()).toBeVisible();

    const invoiceUrl = page.url().split('?')[0]!;

    // 4.3.7 — an ad-hoc line for something agreed on the phone.
    const addLine = page.getByTestId('add-line-form');
    await addLine.getByLabel('New line description').fill('Waiting at arrivals');
    await addLine.getByLabel('New line amount').fill('20.00');
    await addLine.getByRole('button', { name: 'Add line' }).click();
    await expect(page.getByText('£145.50').first()).toBeVisible();

    // 4.3.8 — the printed document carries the letterhead and the breakdown.
    const document = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/document`.replace('/invoices/', '/api/invoices/'));
      return { status: response.status, body: await response.text() };
    }, invoiceUrl);
    expect(document.status).toBe(200);
    expect(document.body).toContain('Waiting at arrivals');
    expect(document.body).toContain('VAT at 20%');
    expect(document.body).toContain(clientName);

    // …and the same document printed. A 503 here means no Chromium on the
    // host, which is a deployment gap rather than a fault — but it is not one
    // to discover by sending a client a link that does not work.
    const pdf = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/pdf`.replace('/invoices/', '/api/invoices/'));
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    }, invoiceUrl);
    expect(pdf.status, 'no PDF renderer on this host').toBe(200);
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.bytes).toBeGreaterThan(1000);

    // Send it. Past this point the recipient holds a copy.
    await page.goto(invoiceUrl);
    await page.getByRole('button', { name: 'Send invoice' }).click();
    await expect(page.getByTestId('invoice-locked')).toBeVisible();
    await expect(page.getByTestId('line-editor')).toHaveCount(0);

    // 4.3.12 — a part payment moves the status without anyone setting it.
    const payment = page.getByTestId('payment-form');
    await payment.getByLabel('Record a payment').fill('50.00');
    await payment.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText('part paid')).toBeVisible();

    const invoiceNumber = (
      await page.getByRole('heading', { level: 1 }).first().textContent()
    )?.trim();
    expect(invoiceNumber).toMatch(/^[A-Z]+-\d{4}-\d{4}$/);

    // 4.4 — it is in the ledger, with the right outstanding figure.
    await page.goto(`/invoices?q=${invoiceNumber}`);
    const row = page.locator('tr', { hasText: invoiceNumber! });
    await expect(row).toBeVisible();
    await expect(row).toContainText('£124.60');

    // 4.4.4 — and on the aging report, under this client's name.
    await page.goto('/invoices/aging');
    const agingRow = page.locator('tr', { hasText: clientName });
    await expect(agingRow).toBeVisible();
    const total = await agingRow.locator('td').last().textContent();
    expect(pence(total ?? '')).toBe(12_460);

    // 4.4.5 — both exports come back as spreadsheets.
    for (const url of ['/api/invoices/export', '/api/invoices/export?report=aging']) {
      const download = await page.evaluate(async (target) => {
        const response = await fetch(target);
        return {
          status: response.status,
          type: response.headers.get('content-type'),
        };
      }, url);
      expect(download.status).toBe(200);
      expect(download.type).toContain('spreadsheetml');
    }
  });

  test('a sent invoice is corrected with a credit note, not an edit', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const clientName = `Credit Client ${Date.now()}`;
    await completedJob(page, clientName, '80.00');

    await billableFor(page, clientName);
    await page.getByRole('button', { name: 'Raise draft invoice' }).click();
    await expect(page).toHaveURL(/\/invoices\/[^/?]+\?/);

    const originalUrl = page.url().split('?')[0]!;
    const originalNumber = (
      await page.getByRole('heading', { level: 1 }).first().textContent()
    )?.trim();

    await page.getByRole('button', { name: 'Send invoice' }).click();
    await expect(page.getByTestId('invoice-locked')).toBeVisible();

    // The API refuses the edit too, not only the screen — a rule enforced
    // only in the UI is not a rule.
    const refused = await page.evaluate(async (url) => {
      const body = new URLSearchParams({
        intent: 'add',
        description: 'Sneaked in',
        amount: '999.00',
      });
      // Followed rather than read from the `Location` header: a manual
      // redirect in the browser is opaque, so the header is not visible to
      // script. The refusal is in the URL it lands on.
      const response = await fetch(
        `${url}/lines`.replace('/invoices/', '/api/invoices/'),
        { method: 'POST', body },
      );
      return response.url;
    }, originalUrl);
    expect(refused).toContain('invoiceError=');
    // Read through `searchParams`, which turns `+` back into a space —
    // `decodeURIComponent` does not.
    expect(new URL(refused).searchParams.get('invoiceError')).toContain(
      'credit note',
    );

    // And nothing was added.
    await page.goto(originalUrl);
    await expect(page.getByText('Sneaked in')).toHaveCount(0);
    await expect(page.getByText('£96.00').first()).toBeVisible();

    await page.goto(originalUrl);
    await page.getByRole('button', { name: 'Raise a credit note' }).click();

    // Lands on the credit note: it is the new document, and it references
    // the original rather than replacing it.
    await expect(page.getByText('This is a credit note.')).toBeVisible();
    await expect(page.getByText('-£80.00').first()).toBeVisible();

    // The original keeps its number and its total.
    await page.goto(originalUrl);
    await expect(
      page.getByRole('heading', { name: originalNumber! }),
    ).toBeVisible();
    await expect(page.getByText('£96.00').first()).toBeVisible();
  });
});
