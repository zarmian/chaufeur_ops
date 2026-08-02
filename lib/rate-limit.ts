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
