import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { zonedDayRange } from '@/lib/dates';
import { getLocaleConfig } from '@/lib/locale-store';
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
    const fromValue = dateField(form.get('from'));
    const toValue = dateField(form.get('to'));

    if (fromValue) query.set('from', fromValue);
    if (toValue) query.set('to', toValue);

    if (!driverId || !fromValue || !toValue) {
      return refuse(query, destination, 'That period was not understood.');
    }

    /*
     * Local days, not UTC ones — the same reading the screen previewed.
     *
     * These dates were typed by an operator into a date input, so "the 31st"
     * is their 31st. Read as UTC, an hour of summer work slid out of one end
     * of the period and into the next payout: the preview and the money
     * disagreed, which is the one thing a payout screen must never do.
     */
    const { timeZone } = await getLocaleConfig();
    const from = zonedDayRange(fromValue, timeZone).start;
    // Inclusive, so work at 6pm on the last day is inside it.
    const to = new Date(
      zonedDayRange(toValue, timeZone).endExclusive.getTime() - 1,
    );

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

/** The `YYYY-MM-DD` a date input posts, or nothing if it is not one. */
function dateField(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
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
