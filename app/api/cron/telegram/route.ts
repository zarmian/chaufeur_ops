import { NextResponse } from 'next/server';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import {
  alertOverdueInvoices,
  alertUnansweredAssignments,
  alertUnassignedJobs,
  chaseExpiringDocuments,
  digestTomorrowsConflicts,
  purgeOldPositions,
  purgeStaleConversations,
} from '@/lib/telegram/chasing';

/**
 * `GET /api/cron/telegram` — the bot's scheduled work.
 *
 * One route rather than several, because each step is cheap, none of them
 * matters to the minute, and a single Vercel Cron entry is one less thing to
 * get wrong at deploy time. The morning digest is the exception and has its
 * own entry: the whole point of it is the hour it arrives.
 *
 * Each step is independent and none may stop the others: a failure to chase
 * documents must not leave position pings unpurged, which is a privacy
 * commitment rather than a nicety.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return apiError('UNAUTHENTICATED', 'Missing or invalid cron credentials');
  }

  const [
    documents,
    unassigned,
    unanswered,
    clashes,
    overdue,
    positions,
    conversations,
  ] = await Promise.allSettled([
    chaseExpiringDocuments(),
    alertUnassignedJobs(),
    alertUnansweredAssignments(),
    digestTomorrowsConflicts(),
    alertOverdueInvoices(),
    purgeOldPositions(),
    purgeStaleConversations(),
  ]);

  return NextResponse.json({
    ok: true,
    documents: settled(documents),
    unassigned: settled(unassigned),
    unanswered: settled(unanswered),
    clashes: settled(clashes),
    overdue: settled(overdue),
    positions: settled(positions),
    conversations: settled(conversations),
    ranAt: new Date().toISOString(),
  });
}

/** The outcome, or the reason — so a silent failure is not silent. */
function settled<T>(result: PromiseSettledResult<T>): T | { error: string } {
  return result.status === 'fulfilled'
    ? result.value
    : {
        error:
          result.reason instanceof Error ? result.reason.message : 'unknown failure',
      };
}
