import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { consumeRateLimit, LIMITS, purgeOldRateLimitEvents, requireExportBudget } from './rate-limit';

/**
 * The general limiter — spec 6.7.5.
 *
 * Worth testing against a real database rather than a stub, because the whole
 * design decision here is that the counter lives in Postgres. An in-memory
 * limiter passes a unit test and limits nothing in production, where Vercel
 * runs many short-lived instances and a process-local counter resets on
 * almost every request.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

describe.skipIf(!DATABASE_AVAILABLE)('rate limiting', () => {
  const subjects: string[] = [];

  const subject = (label: string) => {
    const value = `${label}-${stamp}-${subjects.length}`;
    subjects.push(value);
    return value;
  };

  beforeEach(async () => {
    if (!raw) return;
    await raw.rateLimitEvent.deleteMany({ where: { subject: { in: subjects } } });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.rateLimitEvent.deleteMany({ where: { subject: { in: subjects } } });
    await raw.$disconnect();
  });

  it('allows the whole budget and refuses the next one', async () => {
    const who = subject('export-user');
    const { max } = LIMITS.export;

    for (let i = 0; i < max; i += 1) {
      const result = await consumeRateLimit('export', who);
      expect(result.allowed, `call ${i + 1} of ${max} was refused`).toBe(true);
    }

    const overrun = await consumeRateLimit('export', who);
    expect(overrun.allowed).toBe(false);
    expect(overrun.remaining).toBe(0);
  });

  it('counts down as the budget is spent', async () => {
    const who = subject('countdown');

    const first = await consumeRateLimit('export', who);
    const second = await consumeRateLimit('export', who);

    expect(first.remaining).toBe(LIMITS.export.max - 1);
    expect(second.remaining).toBe(LIMITS.export.max - 2);
  });

  it('says how long to wait', async () => {
    // A 429 with no number is one people respond to by clicking again.
    const who = subject('retry-after');

    for (let i = 0; i <= LIMITS.export.max; i += 1) {
      await consumeRateLimit('export', who);
    }

    const refused = await consumeRateLimit('export', who);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(
      LIMITS.export.windowMinutes * 60,
    );
  });

  it('keeps one person’s exhausted budget away from another’s', async () => {
    // Per user, not per IP. An office behind one address is one IP, and
    // limiting collectively means the second person to run a report is
    // refused because of the first.
    const heavy = subject('heavy');
    const light = subject('light');

    for (let i = 0; i <= LIMITS.export.max; i += 1) {
      await consumeRateLimit('export', heavy);
    }

    expect((await consumeRateLimit('export', heavy)).allowed).toBe(false);
    expect((await consumeRateLimit('export', light)).allowed).toBe(true);
  });

  it('keeps buckets apart', async () => {
    // A burst of spreadsheet downloads must not lock somebody out of
    // something unrelated.
    const who = subject('two-buckets');

    for (let i = 0; i <= LIMITS.export.max; i += 1) {
      await consumeRateLimit('export', who);
    }

    expect((await consumeRateLimit('export', who)).allowed).toBe(false);
    expect((await consumeRateLimit('webhookAuth', who)).allowed).toBe(true);
  });

  it('ignores hits that have aged out of the window', async () => {
    // The window slides. Without this the limiter is a lifetime cap, which
    // is a support ticket rather than a defence.
    if (!raw) return;
    const who = subject('aged-out');
    const old = new Date(Date.now() - (LIMITS.export.windowMinutes + 5) * 60_000);

    await raw.rateLimitEvent.createMany({
      data: Array.from({ length: LIMITS.export.max + 5 }, () => ({
        bucket: 'export',
        subject: who,
        at: old,
      })),
    });

    expect((await consumeRateLimit('export', who)).allowed).toBe(true);
  });

  it('turns an exhausted export budget into a 429, not a 500', async () => {
    const who = subject('api-error');

    for (let i = 0; i <= LIMITS.export.max; i += 1) {
      await consumeRateLimit('export', who);
    }

    await expect(requireExportBudget(who)).rejects.toThrow(ApiError);
    await expect(requireExportBudget(who)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('purges events nothing will ever read again', async () => {
    if (!raw) return;
    const who = subject('purge');

    await raw.rateLimitEvent.create({
      data: {
        bucket: 'export',
        subject: who,
        at: new Date(Date.now() - 48 * 60 * 60_000),
      },
    });

    await purgeOldRateLimitEvents();

    const left = await raw.rateLimitEvent.count({ where: { subject: who } });
    expect(left).toBe(0);
  });
});
