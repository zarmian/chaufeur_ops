import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import type { BankTxnKind } from '@/lib/bank/classify';
import {
  confirmIgnore,
  confirmInvoiceAllocation,
  confirmPayoutMatch,
  confirmVehicleCost,
  reclassify,
  undoAllocation,
} from '@/lib/bank/store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/reconciliation/:id/actions` — classify, confirm, undo.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * A refusal here is nearly always a rule rather than a fault — "undo the
 * allocation before reclassifying it" — so it comes back on the URL for the
 * page to render rather than reaching the error boundary.
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
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');

    if (intent === 'classify') {
      const result = await reclassify(id, {
        kind: String(form.get('kind') ?? 'UNCLASSIFIED') as BankTxnKind,
        clientId: value(form.get('clientId')),
        accountId: value(form.get('accountId')),
        driverId: value(form.get('driverId')),
        vehicleId: value(form.get('vehicleId')),
      });
      if (!result.ok) query.set('bankError', result.message);
    } else if (intent === 'allocate') {
      const result = await confirmInvoiceAllocation(id, audit);
      if (!result.ok) query.set('bankError', result.message);
    } else if (intent === 'payout') {
      const payoutId = value(form.get('payoutId'));
      if (!payoutId) {
        query.set('bankError', 'Choose which payout this paid.');
      } else {
        const result = await confirmPayoutMatch(id, payoutId, audit);
        if (!result.ok) query.set('bankError', result.message);
      }
    } else if (intent === 'cost') {
      const vehicleId = value(form.get('vehicleId'));
      if (!vehicleId) {
        query.set('bankError', 'Choose which vehicle this was for.');
      } else {
        const result = await confirmVehicleCost(
          id,
          {
            vehicleId,
            kind: String(form.get('costKind') ?? 'OTHER'),
            note: value(form.get('note')),
          },
          audit,
        );
        if (!result.ok) query.set('bankError', result.message);
      }
    } else if (intent === 'ignore') {
      const result = await confirmIgnore(id, audit);
      if (!result.ok) query.set('bankError', result.message);
    } else if (intent === 'undo') {
      const result = await undoAllocation(id, audit);
      if (!result.ok) query.set('bankError', result.message);
    } else {
      query.set('bankError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'bankError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('bankError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/reconciliation/${id}?${query.toString()}` },
  });
}

function value(input: FormDataEntryValue | null): string | null {
  const text = String(input ?? '').trim();
  return text === '' || text === 'none' ? null : text;
}
