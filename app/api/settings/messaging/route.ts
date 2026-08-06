import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import {
  saveClientMessagingConfig,
  TEMPLATES,
  type TemplateName,
} from '@/lib/client-messaging';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/messaging` — spec 5.10.
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

    const enabled = Object.fromEntries(
      TEMPLATES.map((template) => [template.value, flag(form, template.value)]),
    ) as Record<TemplateName, boolean>;

    const result = await saveClientMessagingConfig(
      {
        smsProvider: String(form.get('smsProvider') ?? 'none') === 'twilio'
          ? 'twilio'
          : 'none',
        smsAccountSid: String(form.get('smsAccountSid') ?? ''),
        smsAuthToken: String(form.get('smsAuthToken') ?? ''),
        smsFromNumber: String(form.get('smsFromNumber') ?? ''),
        enabled,
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) query.set('messagingError', result.message);
    else query.set('messagingNotice', 'Saved.');
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'messagingError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/messaging?${query.toString()}` },
  });
}

/** The last value posted wins: a hidden `false` then a `true` when checked. */
function flag(form: FormData, name: string): boolean {
  const values = form.getAll(name).map(String);
  return values[values.length - 1] === 'true';
}
