import { ApiError } from './api';
import { prisma } from './prisma';

/**
 * Login throttling, per the Phase 0 spec: five failed attempts per IP in
 * fifteen minutes, then a lockout.
 *
 * Backed by a table rather than memory because Vercel runs many short-lived
 * instances — an in-process counter would reset on almost every request and
 * throttle nothing.
 */

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MINUTES = 15;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function windowStart(): Date {
  return new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60_000);
}

/** Read the client IP from proxy headers, falling back to a stable unknown key. */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  const since = windowStart();

  const failures = await prisma.loginAttempt.findMany({
    where: { ip, successful: false, attemptedAt: { gte: since } },
    orderBy: { attemptedAt: 'asc' },
    select: { attemptedAt: true },
  });

  if (failures.length < LOGIN_MAX_ATTEMPTS) {
    return {
      allowed: true,
      remaining: LOGIN_MAX_ATTEMPTS - failures.length,
      retryAfterSeconds: 0,
    };
  }

  // The lockout lifts when the oldest failure ages out of the window.
  const oldest = failures[0]!.attemptedAt;
  const unlocksAt = oldest.getTime() + LOGIN_WINDOW_MINUTES * 60_000;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((unlocksAt - Date.now()) / 1000)),
  };
}

export async function recordLoginAttempt(
  ip: string,
  email: string | null,
  successful: boolean,
): Promise<void> {
  await prisma.loginAttempt.create({
    data: { ip, email: email?.toLowerCase() ?? null, successful },
  });
}

/** A successful login clears the IP's failure history. */
export async function clearLoginFailures(ip: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { ip, successful: false } });
}

/** Housekeeping: drop attempts far outside any window. Called by cron. */
export async function purgeOldLoginAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  const { count } = await prisma.loginAttempt.deleteMany({
    where: { attemptedAt: { lt: cutoff } },
  });
  return count;
}

/**
 * A general sliding-window limiter — spec 6.7.5.
 *
 * The budgets below are deliberately loose. The thing being defended against
 * is a script, not a person: an accountant pulling the same spreadsheet four
 * times in a row because the first one looked wrong is normal behaviour, and
 * a limit that catches them is a limit that gets removed. Twenty exports in
 * ten minutes is well past anything anybody does by hand and well short of
 * what it takes to make an unpaginated ten-thousand-row report hurt.
 *
 * Sliding rather than fixed windows, so a limit does not reset on a clock
 * boundary and let through double the allowance either side of it.
 */
export const LIMITS = {
  /** Unpaginated spreadsheets — the most expensive thing a signed-in user can ask for. */
  export: { max: 20, windowMinutes: 10 },
  /** Failed webhook authentication. Valid updates are never counted. */
  webhookAuth: { max: 30, windowMinutes: 5 },
} as const;

export type RateLimitBucket = keyof typeof LIMITS;

/**
 * Record a hit and say whether it was within budget.
 *
 * Records first, then counts — so two simultaneous requests cannot both read
 * a count below the limit and both proceed. It means the limit can be
 * exceeded by the number of genuinely concurrent requests, which for a
 * download somebody clicked is not a meaningful gap.
 */
export async function consumeRateLimit(
  bucket: RateLimitBucket,
  subject: string,
): Promise<RateLimitResult> {
  const { max, windowMinutes } = LIMITS[bucket];
  const since = new Date(Date.now() - windowMinutes * 60_000);

  await prisma.rateLimitEvent.create({ data: { bucket, subject } });

  const hits = await prisma.rateLimitEvent.findMany({
    where: { bucket, subject, at: { gte: since } },
    orderBy: { at: 'asc' },
    select: { at: true },
    // One past the limit is all that is needed to decide, and it stops a
    // hammering client turning the check itself into the expensive part.
    take: max + 1,
  });

  if (hits.length <= max) {
    return { allowed: true, remaining: max - hits.length, retryAfterSeconds: 0 };
  }

  const oldest = hits[0]!.at;
  const freesAt = oldest.getTime() + windowMinutes * 60_000;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((freesAt - Date.now()) / 1000)),
  };
}

/**
 * The one line an export route needs — spec 6.7.5.
 *
 * Per user, not per IP. An office behind one address is one IP, and limiting
 * it collectively would mean the second person to run a report gets refused
 * because of the first.
 *
 * The refusal says how long to wait. A 429 with no number is one people
 * respond to by clicking again.
 */
export async function requireExportBudget(userId: string): Promise<void> {
  const result = await consumeRateLimit('export', userId);
  if (result.allowed) return;

  const minutes = Math.ceil(result.retryAfterSeconds / 60);
  throw new ApiError(
    'RATE_LIMITED',
    `Too many exports. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  );
}

/** Housekeeping: drop events far outside any window. Called by cron. */
export async function purgeOldRateLimitEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  const { count } = await prisma.rateLimitEvent.deleteMany({
    where: { at: { lt: cutoff } },
  });
  return count;
}
