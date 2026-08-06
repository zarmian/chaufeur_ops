import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { testEmailConnection, type EmailProvider } from '@/lib/email';
import { getEmailConfig, saveEmailConfig } from '@/lib/email-store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/email` — save, or test.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * "Test" saves nothing. It verifies the key that is *already stored* against
 * the provider, so a test that passes describes the configuration that will
 * actually be used — testing an unsaved value would prove something about a
 * state the system is not in.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const form = await request.formData();
    const intent = String(form.get('intent') ?? 'save');

    if (intent === 'test') {
      const result = await testEmailConnection(await getEmailConfig());
      query.set(
        result.ok ? 'emailNotice' : 'emailError',
        result.ok
          ? 'The provider accepted that key.'
          : result.message,
      );
    } else {
      const provider = String(form.get('provider') ?? 'none') as EmailProvider;
      const result = await saveEmailConfig(
        {
          provider:
            provider === 'resend' || provider === 'postmark' ? provider : 'none',
          fromAddress: String(form.get('fromAddress') ?? ''),
          fromName: String(form.get('fromName') ?? '') || null,
          replyTo: String(form.get('replyTo') ?? '') || null,
          apiKey: String(form.get('apiKey') ?? ''),
        },
        { userId: user.id, ip: clientIpFrom(await headers()) },
      );

      if (result.ok) {
        query.set('emailNotice', 'Saved.');
      } else {
        query.set('emailError', result.message);
      }
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'emailError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/email?${query.toString()}` },
  });
}
