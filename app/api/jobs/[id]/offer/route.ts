import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { offerJob, withdrawOffers } from '@/lib/telegram/offers';

/**
 * `POST /api/jobs/:id/offer` — put an unassigned job to several drivers.
 *
 * A form post rather than a Server Action, for the same reason as the status
 * control next door: the outcome has to survive a redirect and be visible on
 * the page that comes back, and a form post has no hydration window in which
 * the response can be discarded.
 *
 * Guarded by `editJobs` — the same capability as assigning one by hand, which
 * is what this is a bulk version of. `ACCOUNTS` and `VIEWER` cannot reach it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URLSearchParams();

  try {
    await requireCapability('editJobs');
    const form = await request.formData();

    if (String(form.get('intent') ?? '') === 'withdraw') {
      const { withdrawn } = await withdrawOffers(id);
      query.set(
        'offer',
        withdrawn === 0
          ? 'There was nothing out to withdraw.'
          : `Withdrawn from ${withdrawn} driver${withdrawn === 1 ? '' : 's'}.`,
      );
    } else {
      const result = await offerJob(id);

      if (!result.ok) {
        query.set('offerError', result.message);
      } else {
        /*
         * Both halves reported, because the skipped half is the actionable
         * one. "Offered to 3 drivers" on a fleet of 195 looks like the
         * feature is broken; "offered to 3, 17 skipped on compliance" is a
         * morning's chasing that somebody can actually do.
         */
        const skipped =
          result.skipped.length > 0
            ? `, ${result.skipped.length} skipped on compliance`
            : '';
        query.set(
          'offer',
          `Offered to ${result.offered} driver${result.offered === 1 ? '' : 's'}${skipped}.`,
        );
      }
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

  // Relative, for the reason set out in the status route: an absolute
  // Location built from `request.url` can send the browser to a different
  // origin and drop the session cookie.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/jobs/${id}?${query.toString()}` },
  });
}
