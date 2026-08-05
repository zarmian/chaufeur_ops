import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { localeSchema, saveLocaleConfig } from '@/lib/locale-store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/locale` — currency, locale, timezone, tax and distance.
 *
 * A plain form post to a route handler, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();

    await saveLocaleConfig(
      localeSchema.parse({
        currency: form.get('currency') ?? 'GBP',
        locale: form.get('locale') ?? 'en-GB',
        timeZone: form.get('timeZone') ?? 'Europe/London',
        taxName: form.get('taxName') ?? 'VAT',
        taxRatePct: form.get('taxRatePct') ?? '20',
        distanceUnit: form.get('distanceUnit') ?? 'miles',
      }),
      audit,
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'localeError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  if (!query.has('localeError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/locale?${query.toString()}` },
  });
}
