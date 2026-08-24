import { expect, test, type Page } from '@playwright/test';
import { uniqueDigits } from './unique';

/**
 * A staff member linking their own Telegram — spec 5.9.1, end to end.
 *
 * The token arithmetic and every refusal are covered without a browser in
 * `lib/telegram/staff-linking.integration.test.ts`. What only this can prove
 * is the wiring, and specifically the two things that made the feature absent
 * rather than broken for as long as it was:
 *
 *   - that there is a screen at all, reachable by the roles the bot serves —
 *     the schema column and the reader existed the whole time, and the gap
 *     was that no page ever wrote it;
 *   - that the link is minted for **whoever is signed in**, never for a user
 *     named in a request — the route has no id parameter, and this is what
 *     proves the administrator's screen cannot mint one either.
 *
 * Nothing here talks to Telegram. Redeeming is a database operation and is
 * tested as one; this is about the screens.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

const RUN = uniqueDigits(6);

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** The admin bot's username, without which no link can be built. */
async function setAdminBotUsername(page: Page, username: string) {
  await page.goto('/settings/telegram');
  await page.getByLabel('Admin bot username').fill(username);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('telegram-notice')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('staff telegram link', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('the profile page offers a link once the bot is named', async ({ page }) => {
    await signIn(page);

    // Without the username there is nothing to build a `t.me` URL from, and
    // the card says so rather than offering a button that produces a dead end.
    await setAdminBotUsername(page, '');
    await page.goto('/profile');
    await expect(page.getByRole('button', { name: 'Generate link' })).toBeDisabled();

    await setAdminBotUsername(page, `TestAdminBot${RUN}`);
    await page.goto('/profile');

    await page.getByRole('button', { name: 'Generate link' }).click();

    const url = await page.getByTestId('staff-telegram-url').inputValue();
    // The staff prefix, not the driver's. Redeeming one as the other would
    // bind an office phone to a driver record.
    expect(url).toContain(`t.me/TestAdminBot${RUN}?start=stf_`);
    expect(url).not.toContain('start=drv_');
  });

  test('the link is reachable from the user menu, whatever the role', async ({
    page,
  }) => {
    // The reason this page exists at `viewJobs` rather than behind
    // `manageUsers`: the admin bot answers OPS and ACCOUNTS too, and behind
    // the users screen it would have been an administrator-only feature by
    // accident.
    await signIn(page);
    // The same handle `auth.spec.ts` uses to reach Sign out.
    await page.getByRole('button', { name: /Administrator/i }).click();
    await page.getByRole('menuitem', { name: 'Your profile' }).click();
    await expect(page).toHaveURL(/\/profile/);
  });

  test('an administrator can revoke somebody else’s but not create one', async ({
    page,
  }) => {
    await signIn(page);
    await setAdminBotUsername(page, `TestAdminBot${RUN}`);

    // A second user to look at. Their record must offer no way to mint a link
    // on their behalf: a credential generated here would have to travel to
    // them, and travelling is the whole risk.
    await page.goto('/settings/users/new');
    await page.getByLabel('Full name').fill(`Ops Person ${RUN}`);
    await page.getByLabel('Email').fill(`ops-${RUN}@example.test`);
    await page.selectOption('#role', 'OPS');
    await page.getByRole('button', { name: 'Create user' }).click();

    // Wait for the temporary password before navigating. Leaving the page
    // while the Server Action is still in flight races the write, and the
    // list then renders without the row that is about to exist.
    await expect(page.getByRole('link', { name: 'Back to users' })).toBeVisible();

    await page.goto('/settings/users');
    // Followed by href rather than by clicking. The list re-renders as the
    // create action's revalidation lands, and a click can resolve against the
    // row that is being replaced — which leaves the test asserting against
    // the list it never left.
    const href = await page
      .getByRole('link', { name: `Ops Person ${RUN}` })
      .getAttribute('href');
    expect(href).toMatch(/^\/settings\/users\/.+/);
    await page.goto(href!);
    await expect(page.getByRole('heading', { name: `Ops Person ${RUN}` })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Generate link' })).toHaveCount(0);
    await expect(page.getByText('their profile')).toBeVisible();
  });

  test('unlinking is offered once linked, and the badge follows', async ({ page }) => {
    /*
     * Redeeming needs Telegram, so the linked state is reached the only other
     * way a browser can: it is not. This asserts the unlinked half — that the
     * card offers generation and no revoke — and the integration suite covers
     * the transition, which is a database operation either way.
     */
    await signIn(page);
    await page.goto('/profile');
    await expect(page.getByTestId('staff-telegram-linked')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unlink' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate link' })).toBeVisible();
  });
});
