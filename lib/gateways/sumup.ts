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
 * SumUp, Checkouts API.
 *
 * The important difference from Revolut: **SumUp amounts are decimal major
 * units**, not minor. Money is integer pence everywhere in this system, so
 * the conversion happens here and only here, at the boundary — and comes
 * straight back to pence on the way in. A conversion that leaked further
 * would put a float in the middle of the money path, which is the one thing
 * the whole codebase is built to avoid.
 *
 * The invoice id travels in `checkout_reference` and comes back on the
 * webhook, so a payment is matched by identity rather than by amount.
 *
 * **Untested against the live API.** The request and signature shapes follow
 * SumUp's published Checkouts API; nothing here has been run against real
 * credentials.
 */

function headers(config: GatewayConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** `12550` becomes `125.50`. The only place pence leave this system. */
export function toMajorUnits(pence: number): number {
  return Math.round(pence) / 100;
}

/** `125.50` becomes `12550`, rounded once so a float cannot drift a penny. */
export function toPence(major: number | string): number {
  const value = typeof major === 'string' ? Number(major) : major;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export async function testSumUp(
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult<null>> {
  try {
    const response = await fetchImpl(`${GATEWAY_HOSTS.sumup[config.environment]}/v0.1/me`, {
      headers: headers(config),
    });

    if (!response.ok) {
      return {
        ok: false,
        code: 'BAD_CREDENTIALS',
        message: `SumUp rejected that key (HTTP ${response.status}). Check it is an API key with the payments scope.`,
      };
    }

    const body = (await safeJson(response)) as Record<string, unknown>;
    const profile = (body.merchant_profile ?? {}) as Record<string, unknown>;
    const actual =
      typeof profile.merchant_code === 'string' ? profile.merchant_code : null;

    // Caught here rather than at the first real payment: a key and a merchant
    // code from different accounts authenticate perfectly and then fail on
    // every checkout.
    if (actual && config.merchantCode && actual !== config.merchantCode) {
      return {
        ok: false,
        code: 'MERCHANT_MISMATCH',
        message: `That key belongs to merchant ${actual}, not ${config.merchantCode}. They have to be the same account.`,
      };
    }

    return { ok: true, value: null };
  } catch (error) {
    return unreachable('SumUp', error);
  }
}

export async function createSumUpLink(
  config: GatewayConfig,
  input: {
    invoiceId: string;
    invoiceNumber: string;
    amountPence: number;
    currency: string;
    customerEmail: string | null;
    returnUrl: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult<PaymentLink>> {
  try {
    const response = await fetchImpl(
      `${GATEWAY_HOSTS.sumup[config.environment]}/v0.1/checkouts`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
          // The one place pence become pounds.
          amount: toMajorUnits(input.amountPence),
          currency: input.currency,
          // Carries the invoice id back on the webhook, so a payment is
          // matched by identity rather than by amount.
          checkout_reference: input.invoiceId,
          merchant_code: config.merchantCode,
          description: `Invoice ${input.invoiceNumber}`,
          ...(input.customerEmail ? { pay_to_email: input.customerEmail } : {}),
          ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
        }),
      },
    );

    const body = (await safeJson(response)) as Record<string, unknown>;

    if (!response.ok) {
      return {
        ok: false,
        code: 'LINK_REFUSED',
        message: String(
          body.message ?? `SumUp refused the checkout (HTTP ${response.status})`,
        ).slice(0, 300),
      };
    }

    const id = typeof body.id === 'string' ? body.id : null;
    if (!id) {
      return {
        ok: false,
        code: 'NO_LINK',
        message: 'SumUp accepted the checkout but returned no id.',
      };
    }

    // SumUp returns an id rather than a URL; the hosted page is derived from
    // it. Built here so the caller never has to know the shape.
    return {
      ok: true,
      value: {
        url: `https://pay.sumup.com/b2c/${id}`,
        reference: id,
        expiresAt:
          typeof body.valid_until === 'string' ? new Date(body.valid_until) : null,
      },
    };
  } catch (error) {
    return unreachable('SumUp', error);
  }
}

/**
 * Verify a webhook before parsing it — spec 4.7.5.
 *
 * HMAC-SHA256 over the raw body. Raw, not re-serialised: parsing and
 * re-encoding JSON changes key order and whitespace, and the signature would
 * never match again.
 */
export function verifySumUpSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  if (!input.signatureHeader) return false;

  const expected = createHmac('sha256', input.secret)
    .update(input.rawBody)
    .digest('hex');

  return input.signatureHeader
    .split(',')
    .map((part) => part.trim().replace(/^sha256=/, ''))
    .some((candidate) => safeEqual(candidate, expected));
}

/** A SumUp webhook body as a payment, or null for an event we ignore. */
export function sumUpPaymentFrom(body: unknown): IncomingPayment | null {
  if (typeof body !== 'object' || body === null) return null;
  const event = body as Record<string, unknown>;

  const payload = (event.payload ?? event) as Record<string, unknown>;
  const id =
    typeof payload.id === 'string'
      ? payload.id
      : typeof event.id === 'string'
        ? event.id
        : null;
  if (!id) return null;

  const status = String(payload.status ?? '').toUpperCase();

  return {
    gateway: 'sumup',
    gatewayTxnId: id,
    invoiceId:
      typeof payload.checkout_reference === 'string'
        ? payload.checkout_reference
        : null,
    // Straight back to pence at the boundary.
    amountPence: toPence((payload.amount as number | string) ?? 0),
    currency: typeof payload.currency === 'string' ? payload.currency : 'GBP',
    receivedAt:
      typeof payload.date === 'string' ? new Date(payload.date) : new Date(),
    status:
      status === 'PAID' || status === 'SUCCESSFUL'
        ? 'received'
        : status === 'FAILED'
          ? 'failed'
          : 'pending',
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
