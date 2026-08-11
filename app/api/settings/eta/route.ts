import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { saveEtaConfig } from '@/lib/eta/store';
import type { EtaProviderName } from '@/lib/eta/types';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/eta` — which provider answers "how far away is he",
 * and its key.
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

    const assumedKmh = Number(String(form.get('assumedKmh') ?? '24').trim());

    const result = await saveEtaConfig(
      {
        provider: (String(form.get('provider') ?? 'straight-line') === 'google'
          ? 'google'
          : 'straight-line') as EtaProviderName,
        apiKey: String(form.get('apiKey') ?? ''),
        assumedKmh: Number.isFinite(assumedKmh) ? assumedKmh : 24,
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) query.set('etaError', result.message);
    else query.set('etaNotice', 'Saved.');
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'etaError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/places?${query.toString()}` },
  });
}
