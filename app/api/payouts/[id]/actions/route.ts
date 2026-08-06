import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { fromDateOnlyString } from '@/lib/dates';
import {
  approvePayout,
  deletePayout,
  markPayoutPaid,
} from '@/lib/payout-store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/payouts/:id/actions` — approve, pay, discard.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URLSearchParams();
  let destination = `/payouts/${id}`;

  try {
    const user = await requireCapability('editInvoices');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');

    if (intent === 'approve') {
      const result = await approvePayout(id, audit);
      if (!result.ok) query.set('payoutError', result.message);
    } else if (intent === 'pay') {
      const result = await markPayoutPaid(
        id,
        {
          paidAt: fromDateOnlyString(
            String(form.get('paidAt') ?? '') ||
              new Date().toISOString().slice(0, 10),
          ),
          paymentReference:
            String(form.get('paymentReference') ?? '').trim() || null,
        },
        audit,
      );
      if (!result.ok) query.set('payoutError', result.message);
    } else if (intent === 'discard') {
      const result = await deletePayout(id, audit);
      if (!result.ok) {
        query.set('payoutError', result.message);
      } else {
        // The payout is gone, so there is nothing left to land on.
        destination = '/payouts';
      }
    } else {
      query.set('payoutError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'payoutError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('payoutError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${destination}?${query.toString()}` },
  });
}
