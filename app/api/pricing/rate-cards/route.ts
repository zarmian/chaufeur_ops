import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { retireRateCard, saveRateCard } from '@/lib/pricing/config';
import { rateCardSchema } from '@/lib/pricing/schema';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/pricing/rate-cards` — spec 4.2.1 and 4.2.10.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * Retiring a card in use is not a failure: it is end-dated instead of removed
 * and the operator is told so, which is why that outcome comes back as a
 * notice rather than an error.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const context = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');
    const id = String(form.get('id') ?? '') || null;

    if (intent === 'retire') {
      if (!id) throw new Error('No rate card named');
      const result = await retireRateCard(id, context);
      if (!result.ok) {
        query.set(
          result.code === 'IN_USE' ? 'cardNotice' : 'cardError',
          result.message,
        );
      }
    } else if (intent === 'save') {
      const parsed = rateCardSchema.safeParse({
        name: String(form.get('name') ?? ''),
        activeFrom: String(form.get('activeFrom') ?? ''),
        activeTo: String(form.get('activeTo') ?? ''),
        isDefault: form.get('isDefault') === 'on' ? 'on' : '',
      });

      if (!parsed.success) {
        query.set(
          'cardError',
          parsed.error.issues[0]?.message ?? 'That rate card could not be saved',
        );
      } else {
        const result = await saveRateCard(id, parsed.data, context);
        if (!result.ok) query.set('cardError', result.message);
      }
    } else {
      query.set('cardError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'cardError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('cardError') && !query.has('cardNotice')) {
    query.set('updated', String(Date.now()));
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/pricing/rate-cards?${query.toString()}` },
  });
}
