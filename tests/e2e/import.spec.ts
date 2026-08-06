import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * Phase 3 acceptance: a fresh install loads its records from a spreadsheet.
 *
 * The walk-through that matters is the correction loop — upload, see what is
 * wrong, fix it, upload the same file again, and end up with one record per
 * driver rather than two. Without that, an operator who mistypes row 40 has
 * no way back except doing it by hand, which is what the feature exists to
 * avoid.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const OPS_EMAIL = process.env.E2E_OPS_EMAIL ?? 'ops@example.com';
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD ?? '';

const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Attach a CSV built in the test, without touching the filesystem. */
async function attach(page: Page, name: string, csv: string) {
  await page.getByLabel('CSV file').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
}

async function submitImport(page: Page) {
  await Promise.all([
    page.waitForURL(/[?&](file|importError)=/, { timeout: 20_000 }),
    page.getByRole('button', { name: /^Import/ }).click(),
  ]);
}

test.describe('csv import', () => {
  test.skip(!CREDENTIALS_SET, 'seeded credentials not configured');

  test('checks the file in the browser before anything is sent', async ({
    page,
  }) => {
    // The preview runs the same validators the server does, so an operator
    // fixing 195 rows gets the whole list at once rather than one per upload.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/import/vehicles');

    const stamp = uniqueDigits(6);
    await attach(
      page,
      'fleet.csv',
      [
        'registration,make,model,mot_expiry',
        `E2E${stamp}A,Mercedes-Benz,E-Class,2028-02-28`,
        `E2E${stamp}B,,S-Class,2028-02-28`,
        `E2E${stamp}C,BMW,5 Series,the fifteenth`,
      ].join('\n'),
    );

    await expect(page.getByTestId('preview-valid')).toContainText('1 ready');
    await expect(page.getByTestId('preview-problems')).toContainText('2 problems');
    await expect(page.getByTestId('preview-errors')).toContainText('Row 3');
    await expect(page.getByTestId('preview-errors')).toContainText('Row 4');

    // Nothing was written by looking at it.
    await page.goto('/vehicles?q=E2E' + stamp);
    await expect(page.getByRole('link', { name: `E2E${stamp}A` })).toHaveCount(0);
  });

  test('imports the good rows and skips the rest', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/import/vehicles');

    const stamp = uniqueDigits(6);
    await attach(
      page,
      'fleet.csv',
      [
        'registration,make,model,class,mot_expiry',
        `E2E${stamp}A,Mercedes-Benz,E-Class,EXECUTIVE,2028-02-28`,
        `E2E${stamp}B,,S-Class,EXECUTIVE,2028-02-28`,
      ].join('\n'),
    );
    await submitImport(page);

    await expect(page.getByTestId('import-summary')).toContainText('1 created');
    await expect(page.getByTestId('import-summary')).toContainText('1 skipped');

    await page.goto(`/vehicles?q=E2E${stamp}A`);
    await expect(page.getByRole('link', { name: `E2E${stamp}A` })).toBeVisible();
  });

  test('re-importing a corrected file updates rather than duplicating', async ({
    page,
  }) => {
    // The correction loop, which is the whole point of the natural key.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const stamp = uniqueDigits(6);
    const plate = `E2E${stamp}D`;

    await page.goto('/settings/import/vehicles');
    await attach(
      page,
      'fleet.csv',
      `registration,make,model\n${plate},Mercedes-Benz,E-Clsas`,
    );
    await submitImport(page);
    await expect(page.getByTestId('import-summary')).toContainText('1 created');

    // Fix the typo and run the same file again.
    await page.goto('/settings/import/vehicles');
    await attach(
      page,
      'fleet.csv',
      `registration,make,model\n${plate},Mercedes-Benz,E-Class`,
    );
    await submitImport(page);
    await expect(page.getByTestId('import-summary')).toContainText('0 created');
    await expect(page.getByTestId('import-summary')).toContainText('1 updated');

    // One row, with the corrected model.
    await page.goto(`/vehicles?q=${plate}`);
    await expect(page.getByRole('link', { name: plate })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: plate })).toContainText(
      'E-Class',
    );
  });

  test('a driver file links to a vehicle by registration', async ({ page }) => {
    // Spec 3.5.7 — the two files link in one pass.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const stamp = uniqueDigits(6);
    const plate = `E2E${stamp}V`;
    const phone = `07700${stamp}9`;

    await page.goto('/settings/import/vehicles');
    await attach(
      page,
      'fleet.csv',
      `registration,make,model,mot_expiry,insurance_expiry,phv_licence_expiry\n${plate},Audi,A8,2029-01-31,2029-01-31,2029-01-31`,
    );
    await submitImport(page);

    await page.goto('/settings/import/drivers');
    await attach(
      page,
      'drivers.csv',
      `name,phone,vehicle_registration\nImport E2E ${stamp},${phone},${plate}`,
    );
    await submitImport(page);
    await expect(page.getByTestId('import-summary')).toContainText('1 created');

    await page.goto(`/drivers?q=${stamp}`);
    const link = page.getByRole('link', { name: `Import E2E ${stamp}` });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator('body')).toContainText(plate);
  });

  test('a file that is not CSV at all is refused before upload', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/import/vehicles');

    await attach(page, 'broken.csv', 'registration,make\n"unclosed quote');
    await expect(page.getByTestId('preview-fatal')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  test('the template downloads and names its columns', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/import/drivers');

    // Fetched from inside the page so it carries the session the way the
    // download link does — `page.request` has its own cookie jar.
    const body = await page.evaluate(async () => {
      const response = await fetch('/api/import/template?entity=drivers');
      return { status: response.status, text: await response.text() };
    });

    expect(body.status).toBe(200);
    expect(body.text).toContain('vehicle_registration');
    expect(body.text).toContain('phv_badge_expiry');
    // One example row, so the format of every column is unambiguous.
    expect(body.text.trim().split('\r\n')).toHaveLength(2);
  });

  test('import is ADMIN only', async ({ page }) => {
    test.skip(OPS_PASSWORD === '', 'no OPS credentials configured');
    await signIn(page, OPS_EMAIL, OPS_PASSWORD);

    await page.goto('/settings/import/vehicles');
    await expect(page.getByTestId('import-panel')).toHaveCount(0);
  });
});
