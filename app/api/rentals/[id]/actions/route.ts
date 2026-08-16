import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { parseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import {
  cancelRental,
  deleteRental,
  recordRentalPayment,
  returnRental,
  returnSchema,
} from '@/lib/rental-store';

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
    // Deleting a hire is an administrator's call: it takes a booking off
    // every list at once, and the operator who made the mistake is rarely the
    // one who should decide it never happened.
    const user = await requireCapability(
      intent === 'payment'
        ? 'editJobFinances'
        : intent === 'delete'
          ? 'deleteRecords'
          : 'editVehicles',
    );
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };

    if (intent === 'cancel') {
      const result = await cancelRental(id, audit);
      if (!result.ok) query.set('rentalError', result.message);
    } else if (intent === 'delete') {
      // Read before the delete, because afterwards the row is filtered out of
      // every read and there is nothing left to name in the message.
      const rental = await prisma.vehicleRental.findUnique({
        where: { id },
        select: { reference: true },
      });
      const result = await deleteRental(id, audit);
      if (!result.ok) {
        query.set('rentalError', result.message);
      } else {
        // Nothing left on this page to come back to. Back to the list saying
        // what happened — landing on an unchanged page reads as the button
        // not having worked.
        const done = new URLSearchParams({
          rentalNotice: `${rental?.reference ?? 'That hire'} was deleted.`,
        });
        return new NextResponse(null, {
          status: 303,
          headers: { Location: `/rentals?${done.toString()}` },
        });
      }
    } else if (intent === 'payment') {
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
