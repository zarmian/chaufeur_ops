import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { fromDateOnlyString } from '@/lib/dates';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { createPayout } from '@/lib/payout-store';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/payouts` — draft a payout for one driver and period.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * The lines are rebuilt server-side from the period rather than taken from
 * the form: a screen that could post its own amounts could post any amount,
 * and this one moves money to a person.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();
  let destination = '/payouts/new';

  try {
    const user = await requireCapability('editInvoices');
    const form = await request.formData();

    const driverId = String(form.get('driverId') ?? '').trim();
    const from = dateField(form.get('from'));
    const to = dateField(form.get('to'));

    if (from) query.set('from', String(form.get('from')));
    if (to) query.set('to', String(form.get('to')));

    if (!driverId || !from || !to) {
      return refuse(query, destination, 'That period was not understood.');
    }

    // The end of the day, so work at 6pm on the last day is inside it.
    to.setUTCHours(23, 59, 59, 999);

    const result = await createPayout(
      driverId,
      { from, to },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) {
      return refuse(query, destination, result.message);
    }

    destination = `/payouts/${result.id}`;
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
        : 'That payout could not be drafted',
    );
  }

  return seeOther(destination, query);
}

function dateField(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return fromDateOnlyString(text);
}

function refuse(
  query: URLSearchParams,
  destination: string,
  message: string,
): NextResponse {
  query.set('payoutError', message);
  return seeOther(destination, query);
}

function seeOther(destination: string, query: URLSearchParams): NextResponse {
  const search = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: search ? `${destination}?${search}` : destination },
  });
}
