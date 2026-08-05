import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import {
  deleteVehicleCost,
  recordStandingCost,
  recordVehicleCost,
  standingCostSchema,
  vehicleCostSchema,
} from '@/lib/fleet';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/vehicles/:id/costs` — recording what a car costs to run.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * A refusal here is usually "this car belongs to its driver", which is
 * information rather than a fault, so it comes back on the URL for the page
 * to render rather than reaching the error boundary.
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
    const user = await requireCapability('editJobFinances');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? 'cost');

    if (intent === 'delete') {
      const result = await deleteVehicleCost(String(form.get('costId') ?? ''), audit);
      if (!result.ok) query.set('costError', result.message);
    } else if (intent === 'standing') {
      const result = await recordStandingCost(
        id,
        standingCostSchema.parse({
          kind: form.get('kind') ?? 'INSURANCE',
          label: form.get('label') ?? '',
          amountPence: form.get('amount') ?? '',
          periodMonths: form.get('periodMonths') ?? '12',
          startsOn: form.get('startsOn') ?? '',
          endsOn: form.get('endsOn') ?? '',
          note: form.get('note') ?? '',
        }),
        audit,
      );
      if (!result.ok) query.set('costError', result.message);
    } else {
      const result = await recordVehicleCost(
        id,
        vehicleCostSchema.parse({
          kind: form.get('kind') ?? 'REPAIR',
          amountPence: form.get('amount') ?? '',
          incurredOn: form.get('incurredOn') ?? '',
          supplier: form.get('supplier') ?? '',
          invoiceRef: form.get('invoiceRef') ?? '',
          odometer: form.get('odometer') ?? '',
          note: form.get('note') ?? '',
        }),
        audit,
      );
      if (!result.ok) query.set('costError', result.message);
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'costError',
      error instanceof Error ? error.message.slice(0, 200) : 'That could not be saved',
    );
  }

  if (!query.has('costError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/vehicles/${id}?${query.toString()}` },
  });
}
