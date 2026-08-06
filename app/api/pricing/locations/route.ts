import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { deleteLocation, saveLocation } from '@/lib/pricing/config';
import { locationSchema } from '@/lib/pricing/schema';

/**
 * `POST /api/pricing/locations` — spec 4.1.5.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    await requireCapability('manageSettings');
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');
    const id = String(form.get('id') ?? '') || null;

    if (intent === 'delete') {
      if (!id) throw new Error('No location named');
      await deleteLocation(id);
    } else if (intent === 'save') {
      const parsed = locationSchema.safeParse({
        label: String(form.get('label') ?? ''),
        address: String(form.get('address') ?? ''),
        postcode: String(form.get('postcode') ?? ''),
        zoneId: String(form.get('zoneId') ?? ''),
        isAirport: form.get('isAirport') === 'on' ? 'on' : '',
      });

      if (!parsed.success) {
        query.set(
          'locationError',
          parsed.error.issues[0]?.message ?? 'That location could not be saved',
        );
      } else {
        const result = await saveLocation(id, parsed.data);
        if (!result.ok) query.set('locationError', result.message);
      }
    } else {
      query.set('locationError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'locationError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('locationError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/pricing/locations?${query.toString()}` },
  });
}
