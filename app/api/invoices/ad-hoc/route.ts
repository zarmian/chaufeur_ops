import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { fromDateOnlyString } from '@/lib/dates';
import { disbursementFrom, treatmentFrom } from '@/lib/invoice-lines';
import { createInvoice } from '@/lib/invoice-store';
import { tryParseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/invoices/ad-hoc` — an invoice for something that is not a job.
 *
 * Plenty of what an operator bills never passes through dispatch: a monthly
 * management fee, a late cancellation, an agency commission, a car valet
 * recharged to the client who made it necessary. Until now every invoice had
 * to be raised from a billable job or hire, so these were either not billed
 * or billed by attaching them to an unrelated job — which puts a charge on a
 * line that describes a journey it has nothing to do with, and makes that
 * job's revenue wrong for every report afterwards.
 *
 * The amount is posted here, unlike `POST /api/invoices`, and that difference
 * is the whole point rather than an oversight. There the amount is re-derived
 * from the job, because the job already knows what it is worth and a form
 * that could post its own total could post any total. Here there is no job,
 * nothing else knows the figure, and a person typing it is the only source
 * there could be. What still cannot be posted is the *total*: the lines are
 * stored and `createInvoice` adds them up.
 *
 * One line is required. The invoice opens on its own page straight afterwards,
 * where the existing editor adds the rest — so this collects the least that
 * makes a real document and then gets out of the way.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let destination = '/invoices/ad-hoc';
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('editInvoices');
    const form = await request.formData();

    const accountId = trimmed(form.get('accountId'));
    const clientId = trimmed(form.get('clientId'));

    if (!accountId && !clientId) {
      return refuse(query, destination, 'Choose who this invoice goes to.');
    }

    const description = String(form.get('description') ?? '').trim();
    if (!description) {
      return refuse(
        query,
        destination,
        'Describe what is being charged — the recipient has to know what they are paying for.',
      );
    }

    /*
     * `tryParseMoney` rather than `parseMoney`, so an unreadable figure is a
     * sentence rather than a thrown error. A blank box and "forty quid" both
     * land here, and neither is an exceptional condition.
     */
    const amountPence = tryParseMoney(String(form.get('amount') ?? ''));
    if (amountPence === null) {
      return refuse(query, destination, 'Enter the amount as a figure, such as 450.00.');
    }
    if (amountPence === 0) {
      return refuse(
        query,
        destination,
        'An invoice for nothing is not worth sending. Enter the amount, or a negative figure for a credit.',
      );
    }

    const issueDate = dateField(form.get('issueDate')) ?? new Date();

    const result = await createInvoice(
      {
        // The account is the usual biller; a client is for the rarer case of
        // invoicing the person who rode rather than whoever booked them.
        accountId: accountId ?? null,
        clientId: accountId ? null : (clientId ?? null),
        issueDate,
        // Left to the recipient's payment terms unless one is typed.
        dueDate: dateField(form.get('dueDate')),
        lines: [
          {
            description,
            amountPence,
            disbursementPence: disbursementFrom(
              String(form.get('disbursement') ?? ''),
              amountPence,
            ),
            vatTreatment: treatmentFrom(String(form.get('vatTreatment') ?? '')),
            // No job and no hire. That is what this route is for, and what
            // keeps the charge off a journey it has nothing to do with.
            jobId: null,
            rentalId: null,
          },
        ],
        notes: trimmed(form.get('notes')),
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) return refuse(query, destination, result.message);

    destination = `/invoices/${result.id}`;
    query.set('created', String(Date.now()));
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    return refuse(
      query,
      destination,
      error instanceof Error
        ? error.message.slice(0, 300)
        : 'That invoice could not be raised',
    );
  }

  return see(destination, query);
}

function refuse(
  query: URLSearchParams,
  destination: string,
  message: string,
): NextResponse {
  query.set('error', message);
  return see(destination, query);
}

function see(destination: string, query: URLSearchParams): NextResponse {
  const search = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: search ? `${destination}?${search}` : destination },
  });
}

function trimmed(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

/** A `YYYY-MM-DD` from a date input, read as a plain calendar day. */
function dateField(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? '').trim();
  if (text === '') return null;

  const parsed = fromDateOnlyString(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
