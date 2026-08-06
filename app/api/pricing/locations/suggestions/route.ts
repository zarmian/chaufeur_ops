import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { saveCandidates } from '@/lib/location-mining';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/pricing/locations/suggestions` — spec 6.4.4.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const form = await request.formData();
    const addresses = form.getAll('address').map(String).filter(Boolean);

    if (addresses.length === 0) {
      query.set('locationError', 'Tick the addresses worth saving first');
    } else {
      const result = await saveCandidates(addresses, {
        userId: user.id,
        ip: clientIpFrom(await headers()),
      });
      query.set('created', String(result.created));
      // Named, not counted. Somebody else saving the same address while this
      // screen was open is normal, and worth saying plainly.
      if (result.skipped.length > 0) {
        query.set(
          'locationError',
          `Already saved, so skipped: ${result.skipped.join(', ')}`,
        );
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

  // Relative, for the origin-drift reason documented on the status route.
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: `/settings/pricing/locations/suggestions?${query.toString()}`,
    },
  });
}
