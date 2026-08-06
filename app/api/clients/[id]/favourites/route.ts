import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';

/**
 * `POST /api/clients/:id/favourites` — spec 6.4.6.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * Not audited. `audit_log` covers the records whose history somebody may have
 * to answer for — jobs, money, drivers, vehicles, clients themselves. Which
 * addresses appear first in an autocomplete is a preference, and putting it
 * in the same log as a price change makes the log harder to read for no
 * gain. The favourite is visible on the client's own screen, which is where
 * anybody wondering about it will look.
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
    await requireCapability('editClients');
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');
    const locationId = String(form.get('locationId') ?? '').trim();

    if (!locationId) {
      query.set('clientError', 'Choose a location first');
    } else if (intent === 'add') {
      // Upsert rather than create: adding one twice is a double-click, not an
      // error worth showing somebody.
      await prisma.clientFavouriteLocation.upsert({
        where: { clientId_locationId: { clientId: id, locationId } },
        update: {},
        create: { clientId: id, locationId },
      });
    } else if (intent === 'remove') {
      await prisma.clientFavouriteLocation.deleteMany({
        where: { clientId: id, locationId },
      });
    } else {
      query.set('clientError', 'Unknown action');
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
  const suffix = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/clients/${id}${suffix ? `?${suffix}` : ''}` },
  });
}
