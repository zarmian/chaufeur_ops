import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { createPaymentLink } from '@/lib/gateways/store';
import type { GatewayName } from '@/lib/gateways/types';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';

/**
 * `POST /api/invoices/:id/payment-link` — spec 4.7.3.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * The link comes back on the URL rather than being stored. It is for the
 * outstanding balance at this moment, and a stored one would go stale the
 * first time somebody made a part payment — a link asking again for money
 * already received is how a client pays twice.
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
    await requireCapability('editInvoices');
    const form = await request.formData();
    const gateway = String(form.get('gateway') ?? '');

    if (gateway !== 'revolut' && gateway !== 'sumup') {
      query.set('invoiceError', 'Unknown gateway');
    } else {
      const result = await createPaymentLink(
        id,
        gateway as GatewayName,
        { returnUrl: new URL(`/invoices/${id}`, request.url).toString() },
      );

      if (result.ok) {
        query.set('paymentLink', result.value.url);
      } else {
        query.set('invoiceError', result.message);
      }
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'invoiceError',
      error instanceof Error
        ? error.message.slice(0, 300)
        : 'That link could not be created',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/invoices/${id}?${query.toString()}` },
  });
}
