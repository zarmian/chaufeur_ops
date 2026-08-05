import { NextResponse } from 'next/server';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { countUnpricedCompleted, listUnpricedCompleted } from '@/lib/jobs';

/**
 * `GET /api/cron/unpriced-digest` — the daily nag (spec 2.6.3).
 *
 * The dashboard tile only helps someone already looking at the dashboard.
 * This pushes the same number at whoever is responsible, because a job that
 * was delivered and never billed gets harder to price the longer it is left:
 * the driver's memory of the run is the last reliable record.
 *
 * Email delivery arrives in Phase 4 alongside invoicing, which is where the
 * sender configuration lives. Until then the digest is built and returned, so
 * the schedule, the authorisation and the query are all proven and only the
 * transport is left to wire up.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return apiError('UNAUTHENTICATED', 'Missing or invalid cron credentials');
  }

  const [total, jobs] = await Promise.all([
    countUnpricedCompleted(),
    listUnpricedCompleted(200),
  ]);

  return NextResponse.json({
    ok: true,
    total,
    // Nothing to chase is a normal, good outcome — reported, not silent.
    jobs: jobs.map((job) => ({
      reference: job.reference,
      scheduledAt: job.scheduledAt.toISOString(),
      scheduledAtLocal: formatDateTime(job.scheduledAt),
      route: `${job.pickupText} → ${job.dropoffText}`,
      client: job.client?.name ?? null,
      driver: job.driver?.name ?? null,
    })),
    ranAt: new Date().toISOString(),
  });
}
