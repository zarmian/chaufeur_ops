import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { fromDateOnlyString } from '@/lib/dates';
import {
  createCreditNote,
  markSent,
  recordPayment,
} from '@/lib/invoice-store';
import { parseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/invoices/:id/actions` — send, pay, credit.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * A refusal here is usually a rule rather than a fault — "this has been sent,
 * credit it instead" — so it comes back on the URL for the page to render
 * rather than reaching the error boundary.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URLSearchParams();
  let destination = id;

  try {
    const user = await requireCapability('editInvoices');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');

    if (intent === 'send') {
      const result = await markSent(id, audit);
      if (!result.ok) query.set('invoiceError', result.message);
    } else if (intent === 'payment') {
      const result = await recordPayment(
        id,
        {
          amountPence: parseMoney(String(form.get('amount') ?? '')),
          receivedAt: fromDateOnlyString(
            String(form.get('receivedAt') ?? '') ||
              new Date().toISOString().slice(0, 10),
          ),
          reference: String(form.get('reference') ?? '').trim() || null,
        },
        audit,
      );
      if (!result.ok) query.set('invoiceError', result.message);
    } else if (intent === 'credit') {
      const result = await createCreditNote(id, audit);
      if (!result.ok) {
        query.set('invoiceError', result.message);
      } else {
        // Land on the credit note: it is the new document, and the thing the
        // operator now needs to look at.
        destination = result.id;
      }
    } else {
      query.set('invoiceError', 'Unknown action');
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
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('invoiceError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/invoices/${destination}?${query.toString()}` },
  });
}
