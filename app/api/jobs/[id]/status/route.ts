import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { transitionJob } from '@/lib/jobs';
import { clientIpFrom } from '@/lib/rate-limit';
import { headers } from 'next/headers';
import type { JobStatus } from '@prisma/client';

/**
 * `POST /api/jobs/:id/status` — the status control's target.
 *
 * A plain form post rather than a Server Action, deliberately.
 *
 * As a Server Action this was intermittently lossy: the transition committed
 * to the database and the browser stayed on the old page, so the operator saw
 * a job that had not moved. It reproduced when the click landed while the
 * page was still hydrating — React had adopted the form but was not yet ready
 * to process the action's response, and the redirect was discarded. Neither
 * `revalidatePath` + `router.refresh()` nor redirecting to the same URL fixed
 * it.
 *
 * A form post has no such window. The browser submits it identically before
 * and after hydration, and a 303 is a navigation the browser performs itself
 * rather than one the framework has to apply. For a control whose whole job
 * is "change this, then show me the result", that is the right mechanism.
 *
 * The outcome travels back in the query string so it survives the redirect
 * and can be linked to.
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
    const user = await requireCapability('editJobs');
    const form = await request.formData();
    const next = String(form.get('status') ?? '') as JobStatus;
    const zeroValueReason = form.get('zeroValueReason');

    const result = await transitionJob(
      id,
      next,
      { userId: user.id, ip: clientIpFrom(await headers()) },
      {
        zeroValueReason:
          typeof zeroValueReason === 'string' ? zeroValueReason : undefined,
      },
    );

    if (!result.ok) {
      // The compliance reasons are the actionable part — without them the
      // operator knows only that something is wrong, not which document.
      const detail = result.reasons?.length
        ? `${result.message}: ${result.reasons.join('; ')}`
        : result.message;
      query.set('statusError', detail);
    } else {
      // A changing marker, so the redirect target is never byte-identical to
      // the page that was posted from.
      query.set('updated', String(Date.now()));
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

  // A *relative* Location, and deliberately so. `NextResponse.redirect`
  // requires an absolute URL, and building one from `request.url` sends the
  // browser to whatever host Next reconstructed — which is not necessarily
  // the host the browser is actually on. Locally that turned 127.0.0.1 into
  // localhost, a different origin, so the session cookie was not sent and
  // every status change bounced to the login page. Behind a proxy it could
  // just as easily be an internal hostname.
  //
  // A relative Location (RFC 7231 §7.1.2) is resolved by the browser against
  // the page it is on, so the origin can never drift. 303 so the browser
  // follows with GET rather than repeating the POST.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/jobs/${id}?${query.toString()}` },
  });
}
