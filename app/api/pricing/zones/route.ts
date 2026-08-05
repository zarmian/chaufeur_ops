import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { deactivateZone, saveZone } from '@/lib/pricing/config';
import { zoneSchema } from '@/lib/pricing/schema';

/**
 * `POST /api/pricing/zones` — spec 4.1.1.
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

    if (intent === 'deactivate') {
      if (!id) throw new Error('No zone named');
      await deactivateZone(id);
    } else if (intent === 'save') {
      const parsed = zoneSchema.safeParse({
        name: String(form.get('name') ?? ''),
        postcodes: String(form.get('postcodes') ?? ''),
        active: form.get('active') === 'on' ? 'on' : '',
      });

      if (!parsed.success) {
        query.set(
          'zoneError',
          parsed.error.issues[0]?.message ?? 'That zone could not be saved',
        );
      } else {
        const result = await saveZone(id, parsed.data);
        if (!result.ok) query.set('zoneError', result.message);
      }
    } else {
      query.set('zoneError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'zoneError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('zoneError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/pricing/zones?${query.toString()}` },
  });
}
