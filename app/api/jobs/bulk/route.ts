import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability, type Capability } from '@/lib/authz';
import { runBulkJobs, type BulkIntent } from '@/lib/bulk-jobs';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/jobs/bulk` — the bulk action bar's target. Spec 6.5.
 *
 * A plain form post rather than a Server Action, and this one was learned the
 * hard way twice. As Server Actions these applied their changes and then
 * called `revalidatePath` on the list they were posted from; the router
 * aborted the in-flight action response in order to refetch, so
 * `useActionState` never received the result and the button sat on "Working…"
 * indefinitely. The jobs really had been updated — the only visible symptom
 * was a control that appeared to have hung, which is exactly the control
 * somebody clicks again.
 *
 * A form post has no such window, for the reasons set out in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * Each intent needs its own capability. `ACCOUNTS` may reprice a job and may
 * not reassign it; `OPS` is the other way round. Checking one blanket
 * permission here would quietly widen both.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAPABILITY: Record<BulkIntent, Capability> = {
  price: 'editJobFinances',
  status: 'editJobs',
  assign: 'editJobs',
  invoice: 'editInvoices',
};

export async function POST(request: Request) {
  const query = new URLSearchParams();
  let back = '/jobs';

  try {
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '') as BulkIntent;

    // Where to send them afterwards: the list they were looking at, filters
    // and page intact. From the form rather than the Referer header, which a
    // proxy may strip.
    const returnTo = String(form.get('returnTo') ?? '').trim();
    if (returnTo.startsWith('/jobs')) back = returnTo;

    if (!CAPABILITY[intent]) {
      query.set('bulkError', 'Unknown action');
    } else {
      const user = await requireCapability(CAPABILITY[intent]);
      const result = await runBulkJobs(
        {
          intent,
          jobIds: form.getAll('jobIds').map(String),
          clientPrice: String(form.get('clientPrice') ?? ''),
          driverPrice: String(form.get('driverPrice') ?? ''),
          status: String(form.get('status') ?? ''),
          driverId: String(form.get('driverId') ?? ''),
          invoiceId: String(form.get('invoiceId') ?? ''),
        },
        { userId: user.id, ip: clientIpFrom(await headers()) },
      );

      if (!result.ok) {
        query.set('bulkError', result.message);
      } else {
        query.set('bulkMessage', result.message);
        // Spec 6.5.4 — the list picks this up and polls for progress.
        if (result.operationId) query.set('bulkOperation', result.operationId);
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

  const separator = back.includes('?') ? '&' : '?';

  // Relative, for the origin-drift reason documented on the status route.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${back}${separator}${query.toString()}` },
  });
}
