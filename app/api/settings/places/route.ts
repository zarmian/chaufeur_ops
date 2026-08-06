import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { savePlacesConfig } from '@/lib/places/store';
import type { PlaceProviderName } from '@/lib/places/types';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/places` — which provider, and its key.
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

    const result = await savePlacesConfig(
      {
        provider: (String(form.get('provider') ?? 'postcodes') === 'google'
          ? 'google'
          : 'postcodes') as PlaceProviderName,
        apiKey: String(form.get('apiKey') ?? ''),
        country: String(form.get('country') ?? 'gb'),
        biasLat: number(form.get('biasLat')),
        biasLng: number(form.get('biasLng')),
        biasRadiusMetres: number(form.get('biasRadius')),
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) query.set('placesError', result.message);
    else query.set('placesNotice', 'Saved.');
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'placesError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/places?${query.toString()}` },
  });
}

/** Blank is null, not zero — 0,0 is a point in the Atlantic. */
function number(input: FormDataEntryValue | null): number | null {
  const text = String(input ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
