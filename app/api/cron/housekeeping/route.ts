import { NextResponse } from 'next/server';
import { purgeExpiredSessions } from '@/lib/session';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import { purgeOldLoginAttempts, purgeOldRateLimitEvents } from '@/lib/rate-limit';

/**
 * The pattern every scheduled route follows: verify the bearer token before
 * doing anything at all, then act.
 *
 * Phase 0's cron does housekeeping only — expired sessions and stale login
 * attempts. The expiry chasing, statements and reminders arrive with the
 * records they operate on.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return apiError('UNAUTHENTICATED', 'Missing or invalid cron credentials');
  }

  const [sessions, attempts, rateLimitEvents] = await Promise.all([
    purgeExpiredSessions(),
    purgeOldLoginAttempts(),
    // Spec 6.7.5's limiter writes a row per limited request. Nothing reads
    // one older than its window, and left alone the table would grow forever.
    purgeOldRateLimitEvents(),
  ]);

  return NextResponse.json({
    ok: true,
    purged: { expiredSessions: sessions, oldLoginAttempts: attempts, rateLimitEvents },
    ranAt: new Date().toISOString(),
  });
}
