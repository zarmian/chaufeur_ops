import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import {
  getGatewayConfig,
  saveGatewayConfig,
  testGateway,
} from '@/lib/gateways/store';
import type { GatewayEnvironment, GatewayName } from '@/lib/gateways/types';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/gateways` — save, or test.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * "Test" verifies what is stored rather than what is typed, so a passing test
 * describes the configuration that will actually be used.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const form = await request.formData();
    const gateway = String(form.get('gateway') ?? '');

    if (gateway !== 'revolut' && gateway !== 'sumup') {
      query.set('gatewayError', 'Unknown gateway');
    } else if (String(form.get('intent') ?? 'save') === 'test') {
      const result = await testGateway(await getGatewayConfig(gateway));
      query.set(
        result.ok ? 'gatewayNotice' : 'gatewayError',
        result.ok
          ? `${gateway === 'revolut' ? 'Revolut' : 'SumUp'} accepted those credentials.`
          : result.message,
      );
    } else {
      const result = await saveGatewayConfig(
        gateway as GatewayName,
        {
          enabled: form.get('enabled') === 'on',
          environment:
            form.get('environment') === 'production'
              ? ('production' as GatewayEnvironment)
              : ('sandbox' as GatewayEnvironment),
          merchantCode: String(form.get('merchantCode') ?? '').trim() || null,
          apiKey: String(form.get('apiKey') ?? ''),
          webhookSecret: String(form.get('webhookSecret') ?? ''),
        },
        { userId: user.id, ip: clientIpFrom(await headers()) },
      );

      if (result.ok) {
        query.set('gatewayNotice', 'Saved.');
      } else {
        query.set('gatewayError', result.message);
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
      'gatewayError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/gateways?${query.toString()}` },
  });
}
