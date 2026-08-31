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

/**
 * The same budget again, per account rather than per address.
 *
 * The per-IP limit alone was demonstrably not a limit. Rotating the
 * `X-Forwarded-For` header — which a client sends and this process cannot
 * verify — produced a fresh budget on every request: seven attempts against
 * one account, never once throttled. A botnet gets the same for free without
 * forging anything.
 *
 * Higher than the per-IP figure on purpose. A whole office signs in from one
 * address, so five failures per IP is generous for one person and tight for
 * twenty; five failures against **one account** is already somebody guessing.
 * Ten is the compromise: an operator who has genuinely forgotten their
 * password gets several honest tries, and a spray does not.
 */
export const ACCOUNT_MAX_ATTEMPTS = 10;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function windowStart(): Date {
  return new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60_000);
}

/**
 * How many proxies sit between the internet and this process.
 *
 * One by default, which is Vercel and most single-proxy deployments. Raise it
 * only to match a topology you actually run — every extra hop is one more
 * entry an attacker gets to write.
 */
function trustedProxyHops(): number {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
}

/**
 * The client's address, taken from the end of the chain rather than the start.
 *
 * `X-Forwarded-For` is appended left to right, so the **rightmost** entry is
 * the one the nearest trusted proxy wrote and the leftmost is whatever the
 * client claimed. Reading the first entry — which this did — meant the value
 * the throttle keyed on was chosen by the person being throttled. That was
 * not theoretical: rotating it defeated the login limit completely in
 * testing.
 *
 * With one trusted proxy the last entry is the real peer address and a client
 * cannot influence it, because anything they send gets another entry appended
 * after it.
 *
 * `x-real-ip` is a fallback, not a preference: nginx sets it deliberately,
 * but so can anybody when no proxy overwrites it.
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const chain = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    if (chain.length > 0) {
      // Counting back from the end: hop 1 is the last entry.
      const index = Math.max(0, chain.length - trustedProxyHops());
      const address = chain[index];
      if (address) return address;
    }
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

/**
 * The same window, counted against one account.
 *
 * Keyed on the email as typed-and-lowercased, so it applies to accounts that
 * do not exist too. Not doing that would turn the limiter into the
 * enumeration oracle the login page is carefully not: "throttled after ten"
 * would mean the address is real, "never throttled" would mean it is not.
 */
export async function checkAccountRateLimit(
  email: string,
): Promise<RateLimitResult> {
  const since = windowStart();

  const failures = await prisma.loginAttempt.findMany({
    where: { email: email.toLowerCase(), successful: false, attemptedAt: { gte: since } },
    orderBy: { attemptedAt: 'asc' },
    select: { attemptedAt: true },
    take: ACCOUNT_MAX_ATTEMPTS + 1,
  });

  if (failures.length < ACCOUNT_MAX_ATTEMPTS) {
    return {
      allowed: true,
      remaining: ACCOUNT_MAX_ATTEMPTS - failures.length,
      retryAfterSeconds: 0,
    };
  }

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

/**
 * A successful login clears that person's failures, and only theirs.
 *
 * It used to clear every failure recorded against the IP, which handed anyone
 * with a working password a reset button for the whole office: four guesses
 * at the administrator, one sign-in as themselves, repeat indefinitely. An
 * insider attack, but the exact insider this system's audit trail exists to
 * catch.
 *
 * Scoped to the address *and* the account, so the operator who mistyped twice
 * before getting in is still forgiven — which is the behaviour worth keeping.
 */
export async function clearLoginFailures(
  ip: string,
  email: string,
): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { ip, email: email.toLowerCase(), successful: false },
  });
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
