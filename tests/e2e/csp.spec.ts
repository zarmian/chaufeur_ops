import { expect, test, type Page } from '@playwright/test';

/**
 * Every page, loaded in a browser that reports what the policy refused.
 *
 * This exists because of a specific failure. `connect-src 'self'` was written
 * believing nothing in the browser talked to a third party — and document
 * uploads, which go straight from the browser to Blob storage, had already
 * moved there. The policy blocked every upload before the request opened. No
 * error, no log, no failed assertion anywhere: the progress bar appeared and
 * sat at 0% while an operator tried again. It shipped, and was found days
 * later by a person trying to file a driver's licence.
 *
 * Nothing in the suite could have caught it. The upload spec asserts the
 * token-signing rules by calling the route directly, which is the half that
 * cannot fail silently; the half that did was never driven.
 *
 * So this is deliberately not a test of any feature. It walks the
 * application, listens for `securitypolicyviolation`, and fails on any. A
 * blocked script, stylesheet, image, font or fetch all arrive the same way,
 * which is the point — the next mistake of this shape will not be the same
 * directive, and it should still be caught the morning it lands rather than
 * the week somebody notices.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const CREDENTIALS_SET = ADMIN_PASSWORD !== '';

interface Violation {
  directive: string;
  blocked: string;
  page: string;
}

/**
 * Collect violations for the life of the page.
 *
 * Registered through `addInitScript` so it is installed before any document
 * script runs — a listener added after `goto` misses everything the page did
 * while loading, which is most of what a policy blocks.
 */
async function watchViolations(page: Page, into: Violation[]) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: unknown[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __csp: unknown[] }).__csp.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
  });

  page.on('framenavigated', () => void 0);

  return async function drain(where: string) {
    const found = await page.evaluate(() => {
      const store = (window as unknown as { __csp?: unknown[] }).__csp ?? [];
      (window as unknown as { __csp: unknown[] }).__csp = [];
      return store as Array<{ directive: string; blocked: string }>;
    });
    for (const one of found) into.push({ ...one, page: where });
  };
}

/**
 * The pages an operator actually passes through in a day.
 *
 * Every one of them is server-rendered by the same middleware, so in principle
 * one would do. They are listed out because the policy is per-response and a
 * future change could scope it, and because a page that fails to render at all
 * is worth catching here too.
 */
const PAGES = [
  '/',
  '/jobs',
  '/jobs/new',
  '/dispatch',
  '/drivers',
  '/vehicles',
  '/clients',
  '/accounts',
  '/invoices',
  '/payouts',
  '/reports',
  '/settings',
  '/settings/flights',
  '/settings/telegram',
];

test.describe('the content security policy, as a browser applies it', () => {
  test.skip(!CREDENTIALS_SET, 'E2E_ADMIN_PASSWORD is not set');

  test('blocks nothing the application legitimately needs', async ({
    page,
  }) => {
    const violations: Violation[] = [];
    const drain = await watchViolations(page, violations);

    await page.goto('/login');
    await drain('/login');

    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await drain('sign-in');

    for (const path of PAGES) {
      await page.goto(path);
      // The heading rather than `networkidle`: this application never goes
      // idle under Next 16, and a page that rendered its heading has run the
      // scripts whose blocking this is looking for.
      await expect(page.getByRole('heading').first()).toBeVisible();
      await drain(path);
    }

    expect(
      violations,
      // Printed rather than counted, because the directive and the blocked
      // URI together are the whole diagnosis.
      `The browser refused ${violations.length} request(s):\n${violations
        .map((v) => `  ${v.page}: ${v.directive} blocked ${v.blocked}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The policy still refuses what it should.
   *
   * A policy that blocks nothing passes the test above trivially, and the
   * cheapest way to fix a CSP failure is to widen it until it stops
   * complaining. This is the other half of that pair.
   */
  test('still refuses a host the application has no business calling', async ({
    page,
  }) => {
    const violations: Violation[] = [];
    const drain = await watchViolations(page, violations);

    await page.goto('/login');

    await page.evaluate(async () => {
      try {
        await fetch('https://blocked-by-policy.invalid/probe');
      } catch {
        // Expected — the assertion is on the violation, not the rejection.
      }
    });

    await page.waitForTimeout(250);
    await drain('/login');

    expect(violations.map((v) => v.directive)).toContain('connect-src');
  });
});
