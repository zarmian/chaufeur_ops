import { NextResponse } from 'next/server';
import { apiError, isAuthorisedCronRequest } from '@/lib/api';
import {
  alertUnansweredAssignments,
  alertUnassignedJobs,
  chaseExpiringDocuments,
  purgeOldPositions,
  purgeStaleConversations,
} from '@/lib/telegram/chasing';

/**
 * `GET /api/cron/telegram` — the bot's scheduled work.
 *
 * One route rather than four, because all four are cheap, none of them
 * matters to the minute, and a single Vercel Cron entry is one less thing to
 * get wrong at deploy time.
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

  const [documents, unassigned, unanswered, positions, conversations] =
    await Promise.allSettled([
      chaseExpiringDocuments(),
      alertUnassignedJobs(),
      alertUnansweredAssignments(),
      purgeOldPositions(),
      purgeStaleConversations(),
    ]);

  return NextResponse.json({
    ok: true,
    documents: settled(documents),
    unassigned: settled(unassigned),
    unanswered: settled(unanswered),
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
