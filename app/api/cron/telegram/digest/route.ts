import { NextResponse } from 'next/server';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import { morningDigest } from '@/lib/telegram/chasing';

/**
 * `GET /api/cron/telegram/digest` — the day, first thing.
 *
 * Its own entry rather than a step in the daily route, because unlike the
 * chasing and the purges this one is entirely about *when* it arrives. A job
 * with no driver at six in the morning is a phone call; the same job at nine
 * is a client ringing to ask where the car is.
 *
 * Scheduled in UTC, like every Vercel cron. That means it lands at 06:00
 * through the winter and 07:00 through British Summer Time — early enough
 * either way, and the alternative is two entries and a check that only one of
 * them fires, which is more machinery than an hour's drift deserves.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return apiError('UNAUTHENTICATED', 'Missing or invalid cron credentials');
  }

  try {
    const result = await morningDigest();
    return NextResponse.json({ ok: true, ...result, ranAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'unknown failure',
      ranAt: new Date().toISOString(),
    });
  }
}
