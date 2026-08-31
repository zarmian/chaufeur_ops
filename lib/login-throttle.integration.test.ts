import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_MAX_ATTEMPTS,
  checkAccountRateLimit,
  checkLoginRateLimit,
  clearLoginFailures,
  LOGIN_MAX_ATTEMPTS,
  recordLoginAttempt,
} from './rate-limit';

/**
 * The throttle that a rotated header cannot walk around.
 *
 * The per-IP limit was the only one there was, and an audit showed it was not
 * a limit at all: `X-Forwarded-For` is written by the client, so rotating it
 * produced a fresh budget every request — seven attempts against one account,
 * never refused, against a limit of five. A botnet achieves the same without
 * forging anything.
 *
 * So there is now a second count, keyed on the account. These test the half
 * that survives a spray, and the half that stops one person with a valid
 * password from resetting everybody else's budget.
 *
 * Against a real database on purpose: the counter living in Postgres rather
 * than in memory is the design decision, because Vercel runs many short-lived
 * instances and a process-local count resets on almost every request.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);
const victim = `victim-${stamp}@example.test`;
const bystander = `bystander-${stamp}@example.test`;

describe.skipIf(!DATABASE_AVAILABLE)('the login throttle', () => {
  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  beforeEach(async () => {
    if (!raw) return;
    await raw.loginAttempt.deleteMany({
      where: { OR: [{ email: { contains: stamp } }, { ip: { contains: stamp } }] },
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.loginAttempt.deleteMany({
      where: { OR: [{ email: { contains: stamp } }, { ip: { contains: stamp } }] },
    });
    await raw.$disconnect();
  });

  it('stops a spray that changes address on every attempt', async () => {
    /*
     * The finding, as a test. Each attempt comes from a different address —
     * which is free, because the address is a header the attacker writes —
     * and the per-IP counter therefore never sees more than one. The account
     * counter is what has to notice.
     */
    let refusedAt: number | null = null;

    for (let attempt = 1; attempt <= ACCOUNT_MAX_ATTEMPTS + 3; attempt += 1) {
      const rotatingIp = `${stamp}.rotating.${attempt}`;

      const perIp = await checkLoginRateLimit(rotatingIp);
      const perAccount = await checkAccountRateLimit(victim);

      // Never, because every attempt is a new bucket. This is the hole.
      expect(perIp.allowed, `per-IP at attempt ${attempt}`).toBe(true);

      if (!perAccount.allowed) {
        refusedAt ??= attempt;
        continue;
      }
      await recordLoginAttempt(rotatingIp, victim, false);
    }

    expect(refusedAt).toBe(ACCOUNT_MAX_ATTEMPTS + 1);
  });

  it('still stops one address working through many accounts', async () => {
    // The other direction, and the reason the per-IP count is worth keeping:
    // the account counter never sees this, because no account is hit twice.
    const ip = `${stamp}.single`;

    for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt += 1) {
      await recordLoginAttempt(ip, `target-${stamp}-${attempt}@example.test`, false);
    }

    expect((await checkLoginRateLimit(ip)).allowed).toBe(false);
  });

  it('does not let one account’s failures lock another out', async () => {
    for (let attempt = 0; attempt < ACCOUNT_MAX_ATTEMPTS; attempt += 1) {
      await recordLoginAttempt(`${stamp}.a.${attempt}`, victim, false);
    }

    expect((await checkAccountRateLimit(victim)).allowed).toBe(false);
    // Somebody else signing in is not affected by an attack on a colleague.
    expect((await checkAccountRateLimit(bystander)).allowed).toBe(true);
  });

  it('counts an address that does not exist, so it is not an oracle', async () => {
    /*
     * The login page is careful never to say whether an address is
     * registered. A throttle that only applied to real accounts would say it
     * for them: refused after ten means real, never refused means not.
     */
    const imaginary = `nobody-${stamp}@example.test`;
    for (let attempt = 0; attempt < ACCOUNT_MAX_ATTEMPTS; attempt += 1) {
      await recordLoginAttempt(`${stamp}.b.${attempt}`, imaginary, false);
    }
    expect((await checkAccountRateLimit(imaginary)).allowed).toBe(false);
  });

  it('a success clears only that person’s failures, not the whole office', async () => {
    /*
     * This used to clear every failure recorded against the address, which
     * handed anybody holding one valid password a reset button for everyone
     * who shares their office IP: four guesses at the administrator, one
     * sign-in as themselves, repeat for as long as you like.
     */
    const office = `${stamp}.office`;

    for (let attempt = 0; attempt < ACCOUNT_MAX_ATTEMPTS; attempt += 1) {
      await recordLoginAttempt(office, victim, false);
    }
    expect((await checkAccountRateLimit(victim)).allowed).toBe(false);

    // The insider signs in as themselves, from the same address.
    await clearLoginFailures(office, bystander);

    // The attack on the administrator is still throttled.
    expect((await checkAccountRateLimit(victim)).allowed).toBe(false);
  });

  it('still forgives the operator who mistyped before getting in', async () => {
    // The behaviour worth keeping: two fat-fingered attempts then a success
    // should not leave somebody one slip from a lockout.
    const desk = `${stamp}.desk`;

    await recordLoginAttempt(desk, bystander, false);
    await recordLoginAttempt(desk, bystander, false);
    await clearLoginFailures(desk, bystander);

    const after = await checkAccountRateLimit(bystander);
    expect(after.remaining).toBe(ACCOUNT_MAX_ATTEMPTS);
  });
});
