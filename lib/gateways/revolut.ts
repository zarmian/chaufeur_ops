import { createHmac } from 'node:crypto';
import { safeEqual } from '../secret-store';
import {
  GATEWAY_HOSTS,
  type GatewayConfig,
  type GatewayResult,
  type IncomingPayment,
  type PaymentLink,
} from './types';

/**
 * Revolut Business, Merchant API.
 *
 * An order is created with an amount in minor units, and the response carries
 * a hosted checkout URL. That suits this system exactly: money is already
 * integer pence everywhere, so nothing is converted on the way out and
 * nothing can be lost rounding it back.
 *
 * The invoice id travels in the order's metadata and comes back on the
 * webhook. It is not inferred from the amount — two clients paying the same
 * figure on the same afternoon would be indistinguishable, and a guess
 * credits the wrong invoice.
 *
 * **Untested against the live API.** The request and signature shapes follow
 * Revolut's published Merchant API; nothing here has been run against real
 * credentials, so treat the first sandbox run as the real test.
 */

const API_VERSION = '2024-09-01';

function headers(config: GatewayConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Revolut-Api-Version': API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export async function testRevolut(
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult<null>> {
  try {
    // A cheap authenticated read. Creating an order to test credentials would
    // leave a real order behind on every click of "Test connection".
    const response = await fetchImpl(
      `${GATEWAY_HOSTS.revolut[config.environment]}/api/orders?limit=1`,
      { headers: headers(config) },
    );

    if (!response.ok) {
      return {
        ok: false,
        code: 'BAD_CREDENTIALS',
        message: `Revolut rejected that key (HTTP ${response.status}). Check it is a Merchant API secret key for the ${config.environment} environment.`,
      };
    }

    return { ok: true, value: null };
  } catch (error) {
    return unreachable('Revolut', error);
  }
}

export async function createRevolutLink(
  config: GatewayConfig,
  input: {
    invoiceId: string;
    invoiceNumber: string;
    amountPence: number;
    currency: string;
    customerEmail: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult<PaymentLink>> {
  try {
    const response = await fetchImpl(
      `${GATEWAY_HOSTS.revolut[config.environment]}/api/orders`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
          amount: input.amountPence,
          currency: input.currency,
          description: `Invoice ${input.invoiceNumber}`,
          merchant_order_data: { reference: input.invoiceNumber },
          // The link back. Everything else about matching a payment to an
          // invoice is guesswork.
          metadata: { invoiceId: input.invoiceId },
          ...(input.customerEmail
            ? { customer: { email: input.customerEmail } }
            : {}),
        }),
      },
    );

    const body = (await safeJson(response)) as Record<string, unknown>;

    if (!response.ok) {
      return {
        ok: false,
        code: 'LINK_REFUSED',
        message: String(
          body.message ?? `Revolut refused the order (HTTP ${response.status})`,
        ).slice(0, 300),
      };
    }

    const url = typeof body.checkout_url === 'string' ? body.checkout_url : null;
    const reference = typeof body.id === 'string' ? body.id : null;

    if (!url || !reference) {
      return {
        ok: false,
        code: 'NO_LINK',
        message: 'Revolut accepted the order but returned no checkout URL.',
      };
    }

    return {
      ok: true,
      value: {
        url,
        reference,
        expiresAt:
          typeof body.expires_at === 'string' ? new Date(body.expires_at) : null,
      },
    };
  } catch (error) {
    return unreachable('Revolut', error);
  }
}

/**
 * Verify a webhook before parsing it — spec 4.7.5.
 *
 * The signed payload is `v1.<timestamp>.<body>`, HMAC-SHA256 with the signing
 * secret. Verified against the **raw** body: re-serialising parsed JSON
 * changes key order and whitespace, and the signature would never match
 * again.
 *
 * The timestamp is checked too. A signature stays valid forever otherwise,
 * so a captured request could be replayed to record the same payment
 * repeatedly.
 */
export function verifyRevolutSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  const { rawBody, signatureHeader, timestampHeader, secret } = input;
  if (!signatureHeader || !timestampHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;

  const now = (input.now ?? new Date()).getTime();
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = createHmac('sha256', secret)
    .update(`v1.${timestampHeader}.${rawBody}`)
    .digest('hex');

  // The header may carry several versions, comma-separated. Any match counts,
  // and each is compared in constant time.
  return signatureHeader
    .split(',')
    .map((part) => part.trim().replace(/^v1=/, ''))
    .some((candidate) => safeEqual(candidate, expected));
}

/**
 * A Revolut webhook body as a payment, or null.
 *
 * Null for an event we do not act on. Returning null rather than throwing
 * means an unrecognised event type is a no-op with a 200, which is what a
 * provider needs to stop retrying it.
 */
export function revolutPaymentFrom(body: unknown): IncomingPayment | null {
  if (typeof body !== 'object' || body === null) return null;
  const event = body as Record<string, unknown>;

  const type = String(event.event ?? '');
  if (!type.startsWith('ORDER_')) return null;

  const order = (event.order ?? event) as Record<string, unknown>;
  const id = typeof order.id === 'string' ? order.id : null;
  if (!id) return null;

  const metadata = (order.metadata ?? {}) as Record<string, unknown>;
  const amount = Number(order.amount ?? 0);

  return {
    gateway: 'revolut',
    gatewayTxnId: id,
    invoiceId:
      typeof metadata.invoiceId === 'string' ? metadata.invoiceId : null,
    amountPence: Number.isFinite(amount) ? Math.round(amount) : 0,
    currency: typeof order.currency === 'string' ? order.currency : 'GBP',
    receivedAt:
      typeof order.completed_at === 'string'
        ? new Date(order.completed_at)
        : new Date(),
    status: type === 'ORDER_COMPLETED' ? 'received' : 'pending',
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function unreachable(name: string, error: unknown): GatewayResult<never> {
  return {
    ok: false,
    code: 'UNREACHABLE',
    message:
      error instanceof Error
        ? `${name} could not be reached: ${error.message.slice(0, 200)}`
        : `${name} could not be reached`,
  };
}
