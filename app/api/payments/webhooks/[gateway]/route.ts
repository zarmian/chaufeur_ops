import { NextResponse } from 'next/server';
import { getGatewayConfig, recordGatewayPayment } from '@/lib/gateways/store';
import { revolutPaymentFrom, verifyRevolutSignature } from '@/lib/gateways/revolut';
import { sumUpPaymentFrom, verifySumUpSignature } from '@/lib/gateways/sumup';
import type { GatewayName } from '@/lib/gateways/types';

/**
 * `POST /api/payments/webhooks/:gateway` — spec 4.7.4 and 4.7.5.
 *
 * The one endpoint in this system with no session behind it, which is what
 * makes the signature check the whole of its security. Three rules follow
 * from that, and none of them is optional:
 *
 * 1. **The raw body is read first and parsed last.** A signature covers the
 *    exact bytes sent; parsing and re-serialising changes key order and
 *    whitespace and the signature would never match again. Reading the body
 *    as text also means an unverified request is never handed to a JSON
 *    parser at all.
 * 2. **An unverified request is refused before anything is parsed** — 401,
 *    no body inspected, nothing written.
 * 3. **A gateway with no webhook secret configured refuses everything.** The
 *    alternative is an endpoint that accepts unsigned payments, which is
 *    strictly worse than one that accepts none.
 *
 * A verified event we do not act on still returns 200. A provider retries a
 * non-2xx for days, and there is nothing to retry about an event type this
 * does not handle.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GATEWAYS: GatewayName[] = ['revolut', 'sumup'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ gateway: string }> },
) {
  const { gateway } = await params;

  if (!GATEWAYS.includes(gateway as GatewayName)) {
    return NextResponse.json({ error: 'Unknown gateway' }, { status: 404 });
  }

  const name = gateway as GatewayName;
  const config = await getGatewayConfig(name);

  if (!config.enabled || !config.webhookSecret) {
    // Deliberately the same answer as a bad signature. Telling an unauthorised
    // caller whether a gateway is configured is free reconnaissance.
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  // Raw, before anything else touches it.
  const rawBody = await request.text();

  const verified =
    name === 'revolut'
      ? verifyRevolutSignature({
          rawBody,
          signatureHeader: request.headers.get('revolut-signature'),
          timestampHeader: request.headers.get('revolut-request-timestamp'),
          secret: config.webhookSecret,
        })
      : verifySumUpSignature({
          rawBody,
          signatureHeader:
            request.headers.get('x-payload-signature') ??
            request.headers.get('x-sumup-signature'),
          secret: config.webhookSecret,
        });

  if (!verified) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Malformed body' }, { status: 400 });
  }

  const payment =
    name === 'revolut' ? revolutPaymentFrom(body) : sumUpPaymentFrom(body);

  if (!payment) {
    return NextResponse.json({ ignored: true });
  }

  // No acting user: the provider is the actor. `userId: null` is what the
  // audit log already means by "not a person".
  const result = await recordGatewayPayment(payment, { userId: null, ip: null });

  if (!result.ok) {
    // 200 with the reason: these are all states no retry can fix — an event
    // for an invoice that does not exist, or one carrying no reference — and
    // a non-2xx would have the provider redeliver it for days.
    return NextResponse.json({ ignored: true, reason: result.code });
  }

  return NextResponse.json({ recorded: true, duplicate: !result.created });
}
