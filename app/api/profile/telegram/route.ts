import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { createStaffLinkToken, unlinkStaffUser } from '@/lib/telegram/staff-linking';

/**
 * `POST /api/profile/telegram` — one's own staff link — spec 5.9.1.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * **The user id comes from the session and from nowhere else.** There is no
 * `:id` in the path and no id in the form, so there is no parameter to tamper
 * with: this route can only ever mint or revoke a link for whoever is signed
 * in. A route that accepted a target would need a capability check to stop a
 * VIEWER minting a link for an ACCOUNTS account — and that check would be one
 * refactor away from being dropped. Not having the parameter is the stronger
 * guarantee.
 *
 * Guarded by `viewJobs` — the weakest capability every role holds — because
 * every role the admin bot serves has to be able to reach it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('viewJobs');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');

    if (intent === 'link') {
      const result = await createStaffLinkToken(user.id, audit);
      if (!result.ok) {
        query.set('telegramError', result.message);
      } else {
        if (result.url) query.set('telegramUrl', result.url);
        else query.set('telegramToken', result.token);
        query.set('telegramExpires', result.expiresAt.toISOString().slice(0, 10));
      }
    } else if (intent === 'unlink') {
      const result = await unlinkStaffUser(user.id, audit);
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
    headers: { Location: `/profile?${query.toString()}` },
  });
}
