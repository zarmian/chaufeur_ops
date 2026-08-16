import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { editLines, type LineEdit } from '@/lib/invoice-store';
import { parseMoney, tryParseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { VAT_TREATMENTS, type VatTreatment } from '@/lib/vat';

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

/** The treatments the form may send. Anything else falls back to the default. */
function treatmentField(value: FormDataEntryValue | null): VatTreatment {
  const text = String(value ?? '');
  return VAT_TREATMENTS.some((option) => option.value === text)
    ? (text as VatTreatment)
    : 'STANDARD';
}

/**
 * The pass-through part, which is blank far more often than it is set.
 *
 * A blank means "none", not "unparseable" — and a value larger than the line
 * is refused by clamping rather than by an error, because a negative taxable
 * fare would compute tax backwards.
 */
function disbursementField(
  value: FormDataEntryValue | null,
  amountPence: number,
): number {
  const text = String(value ?? '').trim();
  if (text === '') return 0;
  const parsed = tryParseMoney(text) ?? 0;
  if (amountPence < 0) return Math.max(parsed, amountPence);
  return Math.min(Math.max(0, parsed), amountPence);
}

function parseEdit(form: FormData): LineEdit | null {
  const intent = String(form.get('intent') ?? '');
  const lineId = String(form.get('lineId') ?? '');
  const description = String(form.get('description') ?? '');
  const amount = String(form.get('amount') ?? '');

  switch (intent) {
    case 'add': {
      const amountPence = parseMoney(amount);
      return {
        kind: 'add',
        description,
        amountPence,
        disbursementPence: disbursementField(
          form.get('disbursement'),
          amountPence,
        ),
        vatTreatment: treatmentField(form.get('vatTreatment')),
      };
    }
    case 'update': {
      if (!lineId) return null;
      const amountPence = parseMoney(amount);
      return {
        kind: 'update',
        lineId,
        description,
        amountPence,
        disbursementPence: disbursementField(
          form.get('disbursement'),
          amountPence,
        ),
        vatTreatment: treatmentField(form.get('vatTreatment')),
      };
    }
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
