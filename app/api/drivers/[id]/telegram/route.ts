import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { createLinkToken, unlinkDriver } from '@/lib/telegram/linking';

/**
 * `POST /api/drivers/:id/telegram` — issue or revoke a driver's link.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * The generated link comes back on the query string and is shown once. It is
 * not stored anywhere readable afterwards: a link that binds a phone to a
 * driver's jobs and pay should have exactly one journey, from that screen to
 * that driver.
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
    const user = await requireCapability('editDrivers');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');

    if (intent === 'link') {
      const result = await createLinkToken(id, audit);
      if (!result.ok) {
        query.set('telegramError', result.message);
      } else {
        if (result.url) query.set('telegramUrl', result.url);
        else query.set('telegramToken', result.token);
        query.set('telegramExpires', result.expiresAt.toISOString().slice(0, 10));
      }
    } else if (intent === 'unlink') {
      const result = await unlinkDriver(id, audit);
      if (!result.ok) query.set('telegramError', result.message);
    } else {
      query.set('telegramError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'telegramError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/drivers/${id}?${query.toString()}` },
  });
}
