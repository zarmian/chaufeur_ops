import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { fromDateOnlyString, toDateOnlyString } from '@/lib/dates';
import { createInvoice, type InvoiceLineInput } from '@/lib/invoice-store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { billableFor } from '@/lib/revenue';

/**
 * `POST /api/invoices` — raise a draft invoice from selected work.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * The form sends *which* items to bill and nothing about what they are worth.
 * Amounts are re-derived here from the same `billableFor` the page rendered,
 * because a form that could post its own totals could post any total — and an
 * invoice is the one document where that matters most.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();
  let destination = '/invoices/new';

  try {
    const user = await requireCapability('editInvoices');
    const form = await request.formData();

    const from = dateField(form.get('from'));
    const to = dateField(form.get('to'));
    // Carried back on a refusal so the operator lands on the list they were
    // looking at rather than an unfiltered one.
    if (from) query.set('from', toDateOnlyString(from));
    if (to) query.set('to', toDateOnlyString(to));

    const accountId = trimmed(form.get('accountId'));
    const clientId = trimmed(form.get('clientId'));

    const selected = form
      .getAll('item')
      .map((value) => String(value))
      .map(parseItemValue)
      .filter((item): item is SelectedItem => item !== null);

    if (selected.length === 0) {
      return refuse(query, destination, 'Pick at least one job or hire to bill.');
    }

    if (!from || !to) {
      return refuse(query, destination, 'That period was not understood.');
    }

    // Deliberately unfiltered: a hire is billed to the driver renting the car,
    // so `billableFor` drops rentals entirely once a client or account filter
    // is set. Looking the selection up in the unfiltered set means a selected
    // hire is still priced, and anything not in the period is refused below.
    const billable = await billableFor({
      from,
      to: endOfDay(to),
    });

    const byKey = new Map(
      billable.items.map((item) => [`${item.kind}:${item.id}`, item]),
    );

    const lines: InvoiceLineInput[] = [];
    for (const item of selected) {
      const match = byKey.get(`${item.kind}:${item.id}`);
      if (!match) {
        return refuse(
          query,
          destination,
          'Something selected is no longer billable — it may have been invoiced or changed since this page was opened. Reload and try again.',
        );
      }
      if (match.alreadyInvoiced) {
        return refuse(
          query,
          destination,
          `${match.reference} is already on an invoice.`,
        );
      }
      lines.push({
        description: match.description,
        amountPence: match.amountPence,
        jobId: match.kind === 'JOB' ? match.id : null,
        rentalId: match.kind === 'RENTAL' ? match.id : null,
      });
    }

    const result = await createInvoice(
      {
        accountId: accountId ?? null,
        clientId: accountId ? null : clientId ?? null,
        issueDate: dateField(form.get('issueDate')) ?? new Date(),
        lines,
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) {
      return refuse(query, destination, result.message);
    }

    destination = `/invoices/${result.id}`;
    query.delete('from');
    query.delete('to');
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

  return seeOther(destination, query);
}

interface SelectedItem {
  kind: 'JOB' | 'RENTAL';
  id: string;
}

/** `"JOB:abc"` / `"RENTAL:abc"`, anything else ignored. */
function parseItemValue(value: string): SelectedItem | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;

  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id) return null;
  if (kind !== 'JOB' && kind !== 'RENTAL') return null;

  return { kind, id };
}

function trimmed(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function dateField(value: FormDataEntryValue | null): Date | null {
  const text = trimmed(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return fromDateOnlyString(text);
}

/** The last instant of that day, so work scheduled at 6pm is included. */
function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function refuse(
  query: URLSearchParams,
  destination: string,
  message: string,
): NextResponse {
  query.set('invoiceError', message);
  return seeOther(destination, query);
}

function seeOther(destination: string, query: URLSearchParams): NextResponse {
  const search = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: search ? `${destination}?${search}` : destination },
  });
}
