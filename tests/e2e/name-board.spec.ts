import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * The meet-and-greet board, in a real browser.
 *
 * Everything that can be decided without one is decided in
 * `lib/name-board.test.ts`. This exists for the one thing that cannot be:
 * whether the name actually fits. That depends on the font's metrics and on
 * where the browser chooses to break the lines, and a model of either is a
 * model that will eventually disagree with the thing it describes.
 *
 * It is worth a browser test because the failure is invisible until it is
 * expensive. A board whose second line has fallen off the bottom of a phone
 * looks fine on the desk it was made at and is discovered in an arrivals hall
 * by a driver who cannot fix it.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

const RUN = uniqueDigits(6);

/** A phone held sideways — the shape the board is actually used in. */
const PHONE_LANDSCAPE = { width: 844, height: 390 };

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** An airport transfer with a passenger on it. Returns the job's URL. */
async function airportJob(page: Page, passenger: string): Promise<string> {
  await page.goto('/jobs/new');
  await page.selectOption('#jobType', 'AIRPORT_TRANSFER');
  await page.getByLabel('Date').fill(tomorrow());
  await page.getByLabel('Time').fill('09:00');
  await page.getByLabel('Pickup').fill(`Heathrow T5 ${RUN}`);
  await page.getByLabel('Destination').fill('The Dorchester');
  await page.getByLabel('Passenger name').fill(passenger);
  await page.getByLabel('Client price').fill('125.50');
  await page.getByRole('button', { name: 'Book job' }).click();
  await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 15_000 });
  return page.url();
}

test.describe.configure({ mode: 'serial' });

test.describe('name board', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('an airport transfer offers a board, and a road transfer does not', async ({
    page,
  }) => {
    await signIn(page);

    await airportJob(page, `Mr Jamal Abdullah ${RUN}`);
    await expect(page.getByTestId('name-board-panel')).toBeVisible();

    // A road transfer with a passenger on it is still not a board: the
    // decision was airport transfers only.
    await page.goto('/jobs/new');
    await page.getByLabel('Date').fill(tomorrow());
    await page.getByLabel('Time').fill('11:00');
    await page.getByLabel('Pickup').fill(`Mayfair ${RUN}`);
    await page.getByLabel('Destination').fill('The City');
    await page.getByLabel('Passenger name').fill(`Ms Road ${RUN}`);
    await page.getByLabel('Client price').fill('80.00');
    await page.getByRole('button', { name: 'Book job' }).click();
    await expect(page.getByTestId('job-status')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('name-board-panel')).toHaveCount(0);
  });

  test('the board shows the name and nothing else', async ({ page, context }) => {
    await signIn(page);
    await airportJob(page, `Ms Chen ${RUN}`);

    const link = page.getByTestId('name-board-panel').getByRole('link', {
      name: 'Open the board',
    });
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/board\/.+/);

    const board = await context.newPage();
    await board.setViewportSize(PHONE_LANDSCAPE);
    await board.goto(href!);

    await expect(board.locator('h1')).toHaveText(`Ms Chen ${RUN}`);

    // Nothing else on it. The decision was a plain board — some clients do
    // not want their guests met by one advertising a supplier.
    const text = (await board.locator('body').innerText()).trim();
    expect(text).toBe(`Ms Chen ${RUN}`);
  });

  test('the name fits the board, whatever the name', async ({ page, context }) => {
    await signIn(page);

    /*
     * The four shapes that break a naive fit. A two-letter name has to not
     * become a logo; a single very long word cannot be broken and sets the
     * width; several words have to wrap without falling off the bottom; and
     * CJK glyphs are drawn on a square body, so four of them are as wide as
     * seven Latin letters — which is the case that actually broke it.
     */
    const names = [
      'Li',
      'Mr Christopher Featherstonehaugh-Wellesley',
      'Mr Jamal Abdullah',
      '田中さん',
    ];

    const board = await context.newPage();
    await board.setViewportSize(PHONE_LANDSCAPE);

    for (const name of names) {
      await airportJob(page, name);
      const href = await page
        .getByTestId('name-board-panel')
        .getByRole('link', { name: 'Open the board' })
        .getAttribute('href');

      await board.goto(href!);
      await board.waitForLoadState('networkidle');

      const fit = await board.evaluate(() => {
        const heading = document.querySelector('h1')!;
        const section = document.querySelector('.board')!;
        return {
          textWidth: heading.scrollWidth,
          textHeight: heading.scrollHeight,
          boxWidth: section.clientWidth,
          boxHeight: section.clientHeight,
          documentScrolls:
            document.documentElement.scrollHeight >
              document.documentElement.clientHeight ||
            document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
        };
      });

      expect(fit.textWidth, `${name} runs off the side`).toBeLessThanOrEqual(
        fit.boxWidth,
      );
      expect(fit.textHeight, `${name} runs off the bottom`).toBeLessThanOrEqual(
        fit.boxHeight,
      );
      // A board somebody has to scroll is a board with something hidden on it.
      expect(fit.documentScrolls, `${name} makes the page scroll`).toBe(false);
    }
  });

  test('a made-up link shows nothing', async ({ context }) => {
    // The token is the whole credential, so a wrong one has to be a dead end
    // — and say no more than that.
    const board = await context.newPage();
    const response = await board.goto('/board/not-a-real-token-at-all');
    expect(response?.status()).toBe(404);
    await expect(board.locator('body')).not.toContainText(RUN);
  });

  test('the board stops working once the job is called off', async ({
    page,
    context,
  }) => {
    // A board for a job that is not happening is a driver sent to arrivals
    // for nobody.
    await signIn(page);
    const jobUrl = await airportJob(page, `Dr Okafor ${RUN}`);

    const href = await page
      .getByTestId('name-board-panel')
      .getByRole('link', { name: 'Open the board' })
      .getAttribute('href');

    const board = await context.newPage();
    expect((await board.goto(href!))?.status()).toBe(200);

    await page.goto(jobUrl);
    await page.selectOption('#status', 'CANCELLED');
    await page.getByRole('button', { name: 'Update status' }).click();
    await expect(page.getByTestId('job-status')).toContainText('Cancelled');

    expect((await board.goto(href!))?.status()).toBe(404);
  });
});
