import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { approveShift, closeShift } from '@/lib/shift-store';

/**
 * `POST /api/shifts/:id/actions` — clocking off, and approving.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`. Clocking off decides what a driver is
 * paid, so a submission that silently does not land is not acceptable here.
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
      intent === 'approve' ? 'editJobFinances' : 'editDrivers',
    );
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };

    if (intent === 'approve') {
      const result = await approveShift(id, user.id, audit);
      if (!result.ok) query.set('shiftError', result.message);
    } else {
      const endedAtRaw = String(form.get('endedAt') ?? '').trim();
      if (endedAtRaw === '') {
        query.set('shiftError', 'Enter when the shift ended');
      } else {
        const result = await closeShift(
          id,
          new Date(endedAtRaw),
          Number(form.get('breakMinutes') ?? 0),
          audit,
        );
        if (!result.ok) query.set('shiftError', result.message);
      }
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    throw error;
  }

  if (!query.has('shiftError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/shifts/${id}?${query.toString()}` },
  });
}
