import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4.6 acceptance, end to end.
 *
 * The reconciliation — that the SQL totals equal the sum of the underlying
 * finance records — is proved in `lib/reports.integration.test.ts`, to the
 * penny and against every branch of the expression. What only this can prove
 * is that the screen shows those numbers, that the unpriced count is beside
 * revenue rather than buried, and that both exports carry the filter criteria.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

function dateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The query value each breakdown tab sets. */
function dimensionParam(label: string): string {
  return {
    'Job type': 'jobType',
    Client: 'client',
    Account: 'account',
    Driver: 'driver',
    Vehicle: 'vehicle',
  }[label]!;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test.describe('reports', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('summarises a period, breaks it down, and exports the criteria', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const window = `from=${dateIn(-365)}&to=${dateIn(1)}`;
    await page.goto(`/reports?${window}`);

    // 4.6.2 and 4.6.3 — the tiles, with the unpriced count among them rather
    // than in a footnote. A revenue figure without it is misleading.
    for (const tile of [
      'jobs',
      'revenue',
      'costs',
      'gross-profit',
      'margin',
      'unpriced',
    ]) {
      await expect(page.getByTestId(`tile-${tile}`)).toBeVisible();
    }

    // Equal prominence is the requirement, not merely presence: the unpriced
    // count is in the same tile row and at the same size as revenue.
    const revenueSize = await page
      .getByTestId('tile-revenue')
      .locator('p')
      .last()
      .evaluate((node) => getComputedStyle(node).fontSize);
    const unpricedSize = await page
      .getByTestId('tile-unpriced')
      .locator('p')
      .nth(1)
      .evaluate((node) => getComputedStyle(node).fontSize);
    expect(unpricedSize).toBe(revenueSize);

    // 4.6.5 — the trend chart renders as a real element, not a placeholder.
    await expect(page.getByRole('img', { name: /Revenue and profit by month/ })).toBeVisible();

    // 4.6.4 — every dimension groups without erroring.
    for (const label of ['Job type', 'Client', 'Account', 'Driver', 'Vehicle']) {
      // Followed by href rather than clicked. What this asserts is that each
      // grouping aggregates without erroring; whether the router gets there
      // by a client navigation is a different question and not this one.
      const href = await page
        .getByRole('link', { name: label, exact: true })
        .getAttribute('href');
      expect(href, `no breakdown tab for ${label}`).toContain(
        `by=${dimensionParam(label)}`,
      );
      await page.goto(href!);

      // The error boundary is what a failing aggregate looks like, so its
      // absence is the assertion rather than any particular figure.
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.getByTestId('tile-revenue')).toBeVisible();
    }

    // 4.6.1 — a filter narrows it, and the header says what is included.
    await page.goto(`/reports?${window}&jobType=AIRPORT_TRANSFER`);
    await expect(page.locator('#jobType')).toHaveValue('AIRPORT_TRANSFER');

    // 4.6.7 — both exports come back, and the PDF's document carries the
    // criteria in its header.
    const sheet = await page.evaluate(async (query) => {
      const response = await fetch(`/api/reports/export?${query}`);
      return {
        status: response.status,
        type: response.headers.get('content-type'),
      };
    }, window);
    expect(sheet.status).toBe(200);
    expect(sheet.type).toContain('spreadsheetml');

    const printed = await page.evaluate(async (query) => {
      const response = await fetch(`/api/reports/pdf?${query}&format=html`);
      return { status: response.status, body: await response.text() };
    }, `${window}&jobType=AIRPORT_TRANSFER&by=driver`);
    expect(printed.status).toBe(200);
    expect(printed.body).toContain('Operations report');
    expect(printed.body).toContain('type AIRPORT_TRANSFER');
    expect(printed.body).toContain('all statuses except cancelled');
    expect(printed.body).toContain('By driver');

    const pdf = await page.evaluate(async (query) => {
      const response = await fetch(`/api/reports/pdf?${query}`);
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    }, window);
    expect(pdf.status, 'no PDF renderer on this host').toBe(200);
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.bytes).toBeGreaterThan(1000);
  });

  test('a range with nothing in it reports nothing rather than guessing', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // A window far enough back that no fixture can reach it.
    await page.goto('/reports?from=1990-01-01&to=1990-01-31');

    await expect(page.getByText('No jobs in this range')).toBeVisible();
    await expect(page.getByText('Nothing in this range to chart.')).toBeVisible();
    // Margin on no revenue is undefined, not 0% — printing zero would read
    // as break-even on a month that had no trading at all.
    await expect(page.getByText('No revenue to measure')).toBeVisible();
  });
});
