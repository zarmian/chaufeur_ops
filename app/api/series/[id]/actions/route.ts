import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { transitionJob } from '@/lib/jobs';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { endSeries, jobsInScope, type SeriesScope } from '@/lib/series';

/**
 * `POST /api/series/:id/actions` — cancelling part or all of a series, and
 * ending the series itself. Spec 6.3.6.
 *
 * A plain form post rather than a Server Action, for the reason set out at
 * length in `app/api/jobs/[id]/status/route.ts`: an action that returns to
 * the page it was posted from is intermittently lossy while that page is
 * still hydrating, and this is exactly that shape of control.
 *
 * **Every job is cancelled individually, through `transitionJob`.** Not a
 * bulk `updateMany`. Each one gets its own validation, its own `CANCELLED`
 * event and its own audit entry, because each one is a real booking and
 * "who cancelled my Tuesday car" has to have an answer. A job the state
 * machine refuses is reported, not skipped silently.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES: SeriesScope[] = ['this', 'future', 'all'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('editJobs');
    const context = { userId: user.id, ip: clientIpFrom(await headers()) };

    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');

    if (intent === 'end') {
      await endSeries(id, context);
      query.set('ended', String(Date.now()));
    } else if (intent === 'cancel') {
      const scope = String(form.get('scope') ?? '') as SeriesScope;
      const fromJobId = String(form.get('fromJobId') ?? '');

      if (!SCOPES.includes(scope) || !fromJobId) {
        query.set('seriesError', 'Choose which jobs to cancel');
      } else {
        const jobs = await jobsInScope(id, fromJobId, scope);

        if (jobs.length === 0) {
          query.set('seriesError', 'Nothing in that selection can still be cancelled');
        } else {
          const refused: string[] = [];
          let cancelled = 0;

          for (const job of jobs) {
            const result = await transitionJob(job.id, 'CANCELLED', context);
            if (result.ok) cancelled += 1;
            else refused.push(`${job.reference}: ${result.message}`);
          }

          query.set('cancelled', String(cancelled));
          // Named, not counted. "Two could not be cancelled" tells the
          // operator there is a problem without telling them where it is.
          if (refused.length > 0) query.set('seriesError', refused.join('; '));
        }
      }
    } else {
      query.set('seriesError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    throw error;
  }

  // Relative, for the origin-drift reason documented on the status route.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/jobs/series/${id}?${query.toString()}` },
  });
}
