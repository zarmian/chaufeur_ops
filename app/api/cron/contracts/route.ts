import { NextResponse } from 'next/server';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import { generateAllContracts } from '@/lib/contracts';
import { getLocaleConfig } from '@/lib/locale-store';

/**
 * `GET /api/cron/contracts` — book the days standing contracts owe (spec 6.6).
 *
 * A contract is an arrangement, not a booking: it says a car goes somewhere
 * every weekday at nine, and this is what turns that into jobs somebody can
 * dispatch. Each contract books a couple of weeks ahead, so the board shows
 * next week and a driver can be told about it.
 *
 * Runs early, before the operator's day, so today's work is on the board
 * before anybody looks at it. Safe to run repeatedly: each contract carries a
 * watermark, and a day that already exists is skipped rather than duplicated —
 * see `generateContractJobs`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return apiError('UNAUTHENTICATED', 'Missing or invalid cron credentials');
  }

  const { timeZone } = await getLocaleConfig();

  // No acting user: the schedule did this, not a person. The audit entries on
  // the jobs it creates say the same, which is the honest record.
  const results = await generateAllContracts({ userId: null, ip: null }, { timeZone });

  const created = results.reduce((total, row) => total + row.created.length, 0);
  const problems = results.flatMap((row) =>
    row.skipped
      // "Already booked" is the normal outcome of a second run in a day, not
      // a problem worth reporting as one.
      .filter((skip) => skip.reason !== 'already booked')
      .map((skip) => ({ reference: row.reference, ...skip })),
  );

  return NextResponse.json({
    ok: true,
    contracts: results.length,
    created,
    // Named rather than counted: a contract short of a Tuesday is a car that
    // does not turn up, and a number alone would not say which.
    problems,
    ranAt: new Date().toISOString(),
  });
}
