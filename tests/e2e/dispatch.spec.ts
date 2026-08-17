import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits, uniquePhone, uniquePlate } from './unique';

/**
 * Phase 6.1 and 6.2 acceptance, end to end.
 *
 * What only a browser can prove: that a job dropped on a driver row actually
 * gets assigned, and that a driver who cannot legally take it is refused
 * rather than warned.
 *
 * The distinction is the whole point of the drop handler. Compliance blocks —
 * a lapsed PHV badge is a licensing requirement and no amount of operator
 * judgement changes it. A clash only warns, because two airport runs ninety
 * minutes apart may be perfectly workable and the operator knows the traffic
 * where the system does not.
 *
 * The board's arithmetic is tested against a real database in
 * `lib/dispatch.integration.test.ts`.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

const RUN = uniqueDigits(6);

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

async function selectByOptionText(page: Page, selectId: string, text: string) {
  const select = page.locator(selectId);
  const value = await select
    .locator('option', { hasText: text })
    .first()
    .getAttribute('value');
  expect(value, `no option matching ${text} in ${selectId}`).toBeTruthy();
  await select.selectOption(value!);
}

/** A driver who can legally take work, with a compliant car. Returns their id. */
async function createCompliantDriver(page: Page, name: string): Promise<string> {
  const plate = uniquePlate('DP');

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

  // From the URL, because finding a row by its driver's name means matching
  // an ancestor div — and every ancestor matches, up to the one that holds
  // every row on the board.
  return page.url().split('/drivers/')[1]!.split(/[?#]/)[0]!;
}

/** A booked job with nobody on it, on `day`. */
async function unassignedJob(page: Page, day: string, time: string, pickup: string) {
  await page.goto('/jobs/new');
  await page.getByLabel('Date').fill(day);
  await page.getByLabel('Time').fill(time);
  await page.getByLabel('Pickup').fill(pickup);
  await page.getByLabel('Destination').fill('Heathrow Terminal 5');
  await page.getByLabel('Client price').fill('125.50');
  await page.getByRole('button', { name: 'Book job' }).click();

  const refusal = page.getByTestId('form-error');
  if ((await refusal.count()) > 0) {
    throw new Error(`Booking refused: ${await refusal.innerText()}`);
  }
  await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 15_000 });
}

/**
 * Drag one element onto another, with the mouse.
 *
 * This used to dispatch `DragEvent`s by hand, with a `DataTransfer` stashed
 * on `window` to tie `dragstart` and `drop` into one gesture, a fixed wait
 * between the two steps, and a retry around the whole thing. That was all
 * scaffolding for the HTML5 drag API, which the board no longer uses.
 *
 * Against Pointer Events there is nothing to synthesise: Playwright's mouse
 * produces the real thing, and the board responds to it exactly as it
 * responds to a hand. The intermediate moves are not decoration — the board
 * needs to see the pointer cross its ten-pixel threshold before it treats the
 * gesture as a drag at all, which is the same reason a click on the card's
 * reference link still opens the job.
 */
async function dragOnto(page: Page, fromSelector: string, toSelector: string) {
  // React has to have hydrated: the markup is server-rendered, and a mouse
  // gesture against a tree with no handlers attached does nothing at all.
  await page.waitForLoadState('networkidle');

  const from = page.locator(fromSelector);
  const to = page.locator(toSelector);
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();

  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source) throw new Error('drag source has no box');
  if (!target) throw new Error('drop target has no box');

  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  const endX = target.x + target.width / 2;
  const endY = target.y + target.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Several steps rather than one jump, so the threshold is crossed and the
  // board sees the row under the pointer before the button comes up.
  const STEPS = 12;
  for (let step = 1; step <= STEPS; step += 1) {
    await page.mouse.move(
      startX + ((endX - startX) * step) / STEPS,
      startY + ((endY - startY) * step) / STEPS,
    );
  }

  await page.mouse.up();
}

test.describe.configure({ mode: 'serial' });

test.describe('dispatch', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  const day = dateIn(4);
  const driverName = `Dispatch Driver ${RUN}`;
  const pickup = `Mayfair ${RUN}`;
  let driverId = '';

  test('shows the day, with unassigned work on the left', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    driverId = await createCompliantDriver(page, driverName);
    await unassignedJob(page, day, '09:00', pickup);

    await page.goto(`/dispatch?day=${day}&all=true`);

    await expect(page.getByTestId('unassigned-column')).toBeVisible();
    await expect(
      page.getByTestId('unassigned-job').filter({ hasText: pickup }),
    ).toBeVisible();

    // The driver has a row even with nothing on it, because `all=true`.
    await expect(page.getByText(driverName).first()).toBeVisible();
  });

  test('dropping a job on a driver assigns it', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/dispatch?day=${day}&all=true`);

    const card = page.getByTestId('unassigned-job').filter({ hasText: pickup });
    await expect(card).toBeVisible();
    const jobId = await card.getAttribute('data-job-id');
    expect(jobId).toBeTruthy();

    // By id, not by name. Matching a row through the name in a sibling cell
    // means matching an ancestor div, and every ancestor matches — up to the
    // one that holds every row on the board.
    await expect(page.locator(`[data-driver-id="${driverId}"]`)).toBeVisible();

    await dragOnto(
      page,
      `[data-testid="unassigned-job"][data-job-id="${jobId}"]`,
      `[data-driver-id="${driverId}"]`,
    );

    // The job leaves the unassigned pile, which is the outcome that matters.
    const stillThere = page.getByTestId('unassigned-job').filter({ hasText: pickup });

    // The retry that used to be here is gone with the synthetic events it was
    // covering for: a real mouse gesture either happens or does not, so a
    // failure now means the drop was genuinely refused and the message below
    // will say why.
    try {
      await expect(stillThere).toHaveCount(0, { timeout: 20_000 });
    } catch (error) {
      // Say why rather than timing out on a count. A refusal appears in the
      // board's own message strip, and "expected 0 got 1" hides it.
      const strip = page.getByTestId('dispatch-message');
      const reason =
        (await strip.count()) > 0 ? await strip.innerText() : '(no message shown)';
      throw new Error(`Drop did not assign. Board said: ${reason}\n${String(error)}`);
    }

    // And now sits on that driver's row.
    await expect(
      page.locator(
        `[data-driver-id="${driverId}"] [data-testid="dispatch-block"][data-job-id="${jobId}"]`,
      ),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('warns about a clash on the booking form without blocking it', async ({
    page,
  }) => {
    // Spec 6.2.3 and 6.2.4. The operator knows the traffic; the system does
    // not. The booking still goes through.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/jobs/new');
    await page.getByLabel('Date').fill(day);
    await page.getByLabel('Time').fill('09:15');
    await page.getByLabel('Pickup').fill(`Clash ${RUN}`);
    await page.getByLabel('Destination').fill('Heathrow Terminal 5');
    await page.getByLabel('Client price').fill('125.50');
    await selectByOptionText(page, '#driverId', driverName);

    // The check is debounced, like the rate-card quote.
    await expect(page.getByTestId('conflict-warning')).toBeVisible({
      timeout: 15_000,
    });

    await Promise.all([
      page.waitForURL(/\/jobs\/[^/]+$/, { timeout: 30_000 }),
      page.getByRole('button', { name: 'Book job' }).click(),
    ]);

    await expect(page.getByTestId('job-status')).toBeVisible();
  });

  test('refuses a driver who cannot legally take the job', async ({ page }) => {
    // Compliance is a licensing requirement, not a preference — so unlike a
    // clash, this one blocks.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const lapsedName = `Lapsed Dispatch Driver ${RUN}`;
    await page.goto('/drivers/new');
    await page.getByLabel('Name').fill(lapsedName);
    await page.getByLabel('Phone').fill(uniquePhone());
    await page.getByLabel('DVLA licence expires').fill(dateIn(400));
    await page.getByLabel('PHV badge expires').fill(dateIn(-5));
    await page.getByRole('button', { name: 'Add driver' }).click();
    await expect(page.getByRole('heading', { name: lapsedName })).toBeVisible();
    const lapsedId = page.url().split('/drivers/')[1]!.split(/[?#]/)[0]!;

    await unassignedJob(page, day, '15:00', `Refused ${RUN}`);

    await page.goto(`/dispatch?day=${day}&all=true`);

    const card = page
      .getByTestId('unassigned-job')
      .filter({ hasText: `Refused ${RUN}` });
    await expect(card).toBeVisible();
    const jobId = await card.getAttribute('data-job-id');

    await dragOnto(
      page,
      `[data-testid="unassigned-job"][data-job-id="${jobId}"]`,
      `[data-driver-id="${lapsedId}"]`,
    );

    await expect(page.getByTestId('dispatch-message')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('dispatch-message')).toContainText(/badge|cannot/i);

    // And the job is still sitting where it was.
    await expect(card).toBeVisible();
  });
});
