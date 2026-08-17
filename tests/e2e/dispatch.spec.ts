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

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');

  /*
   * The card first, because that is where the hand starts.
   *
   * `boundingBox()` and `page.mouse` are both viewport-relative, so anything
   * off screen has coordinates the mouse cannot reach. On this board that is
   * the normal case rather than the exception: the fixtures accumulate, a day
   * with `all=true` lists every driver in the database, and the target row is
   * routinely a screen or more below the card. The two frequently cannot both
   * be visible at once, whatever order they are scrolled into.
   *
   * Which is the whole reason the board scrolls itself while a card is held
   * at the edge — so this drives that, rather than working around it.
   */
  await from.scrollIntoViewIfNeeded();
  const source = await from.boundingBox();
  if (!source) throw new Error('drag source has no box');

  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Past the ten-pixel threshold, in steps, so the board sees a gesture
  // rather than a teleport.
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse.move(startX + step * 6, startY + step * 4);
  }

  /*
   * Follow the row until it comes to the pointer.
   *
   * Held part-way into the sensitive band rather than pinned against the very
   * edge: the board's scroll speed is proportional to depth, so the edge is
   * top speed, and at top speed a 76-pixel row can pass between two polls of
   * its position. The test would then chase it in the other direction and
   * oscillate. Half-depth is fast enough to cross a long board and slow
   * enough to be sampled.
   *
   * Which direction is decided from the row's centre, not its top, so a row
   * that is half on screen is still pulled the rest of the way in rather than
   * being pushed back out.
   */
  const BAND = 40;
  const DEADLINE = Date.now() + 15_000;
  let target = await to.boundingBox();

  while (
    Date.now() < DEADLINE &&
    (!target || target.y < 0 || target.y + target.height > viewport.height)
  ) {
    const centre = target ? target.y + target.height / 2 : viewport.height * 2;
    await page.mouse.move(
      viewport.width / 2,
      centre > viewport.height / 2 ? viewport.height - BAND : BAND,
    );
    await page.waitForTimeout(40);
    target = await to.boundingBox();
  }

  if (!target) throw new Error('drop target has no box');
  if (target.y < 0 || target.y + target.height > viewport.height) {
    throw new Error(
      `drop target never scrolled into view (y=${target.y.toFixed(0)}, viewport=${viewport.height})`,
    );
  }

  /*
   * Bring the board to a stop, and the row to the middle, before aiming.
   *
   * Two things go wrong otherwise, and both end with the job on the wrong
   * driver. The pointer is still down at the edge, so the board is still
   * scrolling while the row is measured — and even once it stops, a row that
   * came to rest *near* an edge is inside the sensitive band, so moving onto
   * it starts the board moving again and the release lands a row or two away.
   *
   * Parking the pointer mid-screen stops the scroll; scrolling the row to the
   * middle puts it somewhere the pointer can sit without restarting it. That
   * is what a hand does on arrival — stop, settle, then let go.
   */
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.waitForTimeout(150);

  target = await to.boundingBox();
  if (!target) throw new Error('drop target vanished');

  await page.evaluate(
    ([top, height]) =>
      window.scrollBy(0, top + height / 2 - window.innerHeight / 2),
    [target.y, target.height],
  );
  await page.waitForTimeout(150);

  target = await to.boundingBox();
  if (!target) throw new Error('drop target vanished');

  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.waitForTimeout(120);
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

    // The job leaves the unassigned pile the moment the server accepts it —
    // that is the board's own optimistic removal, and it is the half of the
    // outcome the gesture is responsible for.
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

    /*
     * And the server agrees: the job is on that driver's row.
     *
     * Reloaded rather than waited for. The board asks for a re-render after a
     * successful drop, but that is best-effort — the guarantee it actually
     * makes is the thirty-second poll, and asserting against the faster path
     * is asserting a promise the board never made. A reload reads the server's
     * answer directly, which is the thing worth proving: not how quickly the
     * page repaints, but that the assignment is really there.
     */
    const block = page.locator(
      `[data-driver-id="${driverId}"] [data-testid="dispatch-block"][data-job-id="${jobId}"]`,
    );
    if ((await block.count()) === 0) {
      await page.reload();
      await page.waitForLoadState('networkidle');
    }
    await expect(block).toBeVisible({ timeout: 20_000 });
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
