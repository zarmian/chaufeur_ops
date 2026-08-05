import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { editLines, type LineEdit } from '@/lib/invoice-store';
import { parseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/invoices/:id/lines` — edit a draft's lines, spec 4.3.7.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * The lock is enforced in `editLines`, not here: a refusal has to hold
 * whichever way the edit arrives, and a check in the route handler only
 * protects the route handler.
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
    const user = await requireCapability('editInvoices');
    const form = await request.formData();
    const edit = parseEdit(form);

    if (!edit) {
      query.set('invoiceError', 'Unknown action');
    } else {
      const result = await editLines(id, edit, {
        userId: user.id,
        ip: clientIpFrom(await headers()),
      });
      if (!result.ok) query.set('invoiceError', result.message);
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
        : 'That line could not be changed',
    );
  }

  if (!query.has('invoiceError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/invoices/${id}?${query.toString()}` },
  });
}

function parseEdit(form: FormData): LineEdit | null {
  const intent = String(form.get('intent') ?? '');
  const lineId = String(form.get('lineId') ?? '');
  const description = String(form.get('description') ?? '');
  const amount = String(form.get('amount') ?? '');

  switch (intent) {
    case 'add':
      return { kind: 'add', description, amountPence: parseMoney(amount) };
    case 'update':
      if (!lineId) return null;
      return {
        kind: 'update',
        lineId,
        description,
        amountPence: parseMoney(amount),
      };
    case 'remove':
      if (!lineId) return null;
      return { kind: 'remove', lineId };
    // The direction rides on the submit button's value, so one form can carry
    // both arrows without a hidden field that only ever holds one of them.
    case 'move:up':
      if (!lineId) return null;
      return { kind: 'move', lineId, direction: 'up' };
    case 'move:down':
      if (!lineId) return null;
      return { kind: 'move', lineId, direction: 'down' };
    default:
      return null;
  }
}
