import { NextResponse } from 'next/server';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import { trackFlights } from '@/lib/flights/track';

/**
 * `GET /api/cron/flights` — check the flights that are coming up.
 *
 * Frequent, because the value is entirely in being early: a delay found at
 * five past five is a driver who leaves later, and the same delay found at
 * six is a driver already sitting in a car park on a wait-time clock the
 * client will argue about. Every fifteen minutes is about right; the run
 * itself is cheap, and `shouldRefresh` decides which flights are actually
 * worth a billed lookup.
 *
 * With no provider configured this returns immediately having done nothing,
 * so a schedule can be in place before an install has a key.
 *
 * The summary comes back in the response rather than only being logged: a
 * cron whose only evidence of working is the absence of an error is a cron
 * nobody notices has stopped.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return apiError('UNAUTHENTICATED', 'Missing or invalid cron credentials');
  }

  const summary = await trackFlights();

  return NextResponse.json({
    ok: true,
    ...summary,
    ranAt: new Date().toISOString(),
  });
}
