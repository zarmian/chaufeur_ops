import { createHmac } from 'node:crypto';
import { safeEqual } from './secret-store';

/**
 * Verifying that an inbound text really came from httpSMS.
 *
 * httpSMS signs each webhook with a JWT — HS256 over the signing key you set
 * when creating the webhook — and its docs suggest a JWT library. There is no
 * JWT dependency in this project and this is not the place to earn one: the
 * whole verification is a split, a base64url decode and one HMAC, and the two
 * payment webhooks next door already hand-roll the same comparison.
 *
 * What a library would give for free is the part that is easy to get wrong, so
 * it is done explicitly here: the algorithm is pinned, `none` is refused, and
 * expiry is checked. An unverified webhook on this endpoint would let anybody
 * put words in a driver's mouth on a passenger's page.
 */

export type JwtCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** Generous enough for clock drift, short enough that a capture goes stale. */
const CLOCK_SKEW_SECONDS = 60;

export function verifyHttpSmsJwt(input: {
  authorization: string | null;
  secret: string;
  now?: Date;
}): JwtCheck {
  const { authorization, secret } = input;
  if (!authorization) return { ok: false, reason: 'no Authorization header' };

  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };

  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];

  const header = decodeJson(headerPart);
  if (!header) return { ok: false, reason: 'unreadable header' };

  /*
   * The algorithm is pinned rather than read.
   *
   * Trusting the token's own `alg` is the classic JWT hole: `none` makes every
   * forgery valid, and naming an RSA algorithm can turn the signing key into a
   * public key the attacker already has.
   */
  if (header.alg !== 'HS256') {
    return { ok: false, reason: `unexpected algorithm ${String(header.alg)}` };
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');

  if (!safeEqual(signaturePart, expected)) {
    return { ok: false, reason: 'signature does not match' };
  }

  const payload = decodeJson(payloadPart);
  if (!payload) return { ok: false, reason: 'unreadable payload' };

  // Checked after the signature, so an unsigned token never gets this far.
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);

  if (typeof payload.exp === 'number' && payload.exp + CLOCK_SKEW_SECONDS < now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > now) {
    return { ok: false, reason: 'not valid yet' };
  }

  return { ok: true };
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface InboundText {
  /** The number that sent it — a driver's mobile. */
  from: string;
  body: string;
  /** httpSMS's own id, so the same text twice is not two replies. */
  providerId: string | null;
  receivedAt: Date;
}

/**
 * An httpSMS webhook body as an inbound text, or null.
 *
 * Null for anything this does not act on — a `message.phone.sent` receipt, a
 * shape from a version that moved on — because an unrecognised event has to be
 * a 200 and a no-op. A 5xx would have httpSMS retry it four times and then
 * give up, which turns one ignored event into five.
 *
 * The payload is a CloudEvent: `data.contact` is the sender, `data.owner` is
 * the gateway phone that took the message, and `data.content` is the text.
 */
export function inboundTextFrom(body: unknown): InboundText | null {
  if (typeof body !== 'object' || body === null) return null;
  const event = body as Record<string, unknown>;

  if (event.type !== 'message.phone.received') return null;

  const data = (event.data ?? {}) as Record<string, unknown>;
  const from = typeof data.contact === 'string' ? data.contact.trim() : '';
  const content = typeof data.content === 'string' ? data.content : '';

  if (from === '' || content.trim() === '') return null;

  return {
    from,
    body: content,
    providerId: typeof data.message_id === 'string' ? data.message_id : null,
    receivedAt:
      typeof data.timestamp === 'string' && !Number.isNaN(Date.parse(data.timestamp))
        ? new Date(data.timestamp)
        : new Date(),
  };
}
