import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { parseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { recordRentalPayment, returnRental, returnSchema } from '@/lib/rental-store';

/**
 * `POST /api/rentals/:id/actions` — booking a car back in, and taking money.
 *
 * A plain form post rather than a Server Action, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`: an action whose form is submitted while
 * the page is still hydrating commits the write and then has its redirect
 * discarded, so the browser sits on the old page. A payment that appears not
 * to have been recorded is the worst possible version of that bug — someone
 * takes the money twice.
 *
 * The redirect Location is relative, so the origin can never drift away from
 * the one holding the session cookie.
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
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');
    const user = await requireCapability(
      intent === 'payment' ? 'editJobFinances' : 'editVehicles',
    );
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };

    if (intent === 'payment') {
      const amount = String(form.get('amount') ?? '').trim();
      if (amount === '') {
        query.set('rentalError', 'Enter the amount received');
      } else {
        const paidAtRaw = String(form.get('paidAt') ?? '').trim();
        const result = await recordRentalPayment(
          id,
          parseMoney(amount),
          paidAtRaw ? new Date(paidAtRaw) : new Date(),
          audit,
          {
            method: String(form.get('method') ?? '') || null,
            reference: String(form.get('reference') ?? '') || null,
          },
        );
        if (!result.ok) query.set('rentalError', result.message);
      }
    } else {
      const parsed = returnSchema.parse({
        returnedAt: form.get('returnedAt') ?? '',
        mileageIn: form.get('mileageIn') ?? '',
        fuelInPct: form.get('fuelInPct') ?? '',
        damageNotes: form.get('damageNotes') ?? '',
        damageChargePence: form.get('damageCharge') ?? '',
      });
      const result = await returnRental(id, parsed, audit);
      if (!result.ok) query.set('rentalError', result.message);
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    // A malformed amount or date is the operator's to fix, not a fault.
    query.set(
      'rentalError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  if (!query.has('rentalError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/rentals/${id}?${query.toString()}` },
  });
}
