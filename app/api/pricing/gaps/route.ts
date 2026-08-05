import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clearUnmatched } from '@/lib/pricing/rate-card';

/**
 * `POST /api/pricing/gaps` — forget an unmatched pickup, spec 4.1.7.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    await requireCapability('manageSettings');
    const form = await request.formData();
    const pickupText = String(form.get('pickupText') ?? '').trim();
    if (pickupText) await clearUnmatched(pickupText);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    throw error;
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/pricing/gaps?updated=${Date.now()}` },
  });
}
