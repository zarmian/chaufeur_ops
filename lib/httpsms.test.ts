import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inboundTextFrom, verifyHttpSmsJwt } from './httpsms';

/**
 * Trusting a text that claims to come from the office's gateway phone.
 *
 * This endpoint puts words in a driver's mouth on a page a client is watching.
 * Anybody who finds the URL can POST to it, so the signature is the only thing
 * between a stranger and a message the passenger will read as their driver's.
 *
 * The JWT is verified by hand — there is no JWT dependency in this project —
 * which is exactly why the classic holes are tested rather than assumed.
 */

const SECRET = 'signing-key-from-the-httpsms-dashboard';

/** Sign a token the way httpSMS does: HS256 over header.payload. */
function sign(
  payload: Record<string, unknown>,
  options: { secret?: string; header?: Record<string, unknown> } = {},
): string {
  const header = options.header ?? { alg: 'HS256', typ: 'JWT' };
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const body = `${part(header)}.${part(payload)}`;
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(body)
    .digest('base64url');

  return `${body}.${signature}`;
}

const NOW = new Date('2026-10-17T12:00:00Z');
const soon = Math.floor(NOW.getTime() / 1000) + 600;

describe('verifyHttpSmsJwt', () => {
  it('accepts a token httpSMS signed', () => {
    expect(
      verifyHttpSmsJwt({
        authorization: `Bearer ${sign({ exp: soon })}`,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts it without the Bearer prefix', () => {
    // Providers are inconsistent about it, and refusing a valid signature over
    // a missing word would lose every driver reply.
    expect(
      verifyHttpSmsJwt({
        authorization: sign({ exp: soon }),
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a token signed with a different key', () => {
    const result = verifyHttpSmsJwt({
      authorization: `Bearer ${sign({ exp: soon }, { secret: 'not-the-key' })}`,
      secret: SECRET,
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it('refuses the alg=none forgery', () => {
    /*
     * The classic JWT hole, and the reason the algorithm is pinned rather than
     * read off the token. A verifier that trusts the header's own `alg` treats
     * an unsigned token as valid, and then anybody can be a driver.
     */
    const part = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'none', typ: 'JWT' })}.${part({ exp: soon })}.`;

    const result = verifyHttpSmsJwt({
      authorization: `Bearer ${unsigned}`,
      secret: SECRET,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/algorithm/i);
  });

  it('refuses an algorithm it was not expecting, even a real one', () => {
    // Naming an RSA algorithm is the other half of the same trick: it can turn
    // a signing key into a public key the attacker already has.
    const result = verifyHttpSmsJwt({
      authorization: `Bearer ${sign({ exp: soon }, { header: { alg: 'RS256' } })}`,
      secret: SECRET,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/algorithm/i);
  });

  it('refuses an expired token, so a captured one goes stale', () => {
    const past = Math.floor(NOW.getTime() / 1000) - 3600;

    const result = verifyHttpSmsJwt({
      authorization: `Bearer ${sign({ exp: past })}`,
      secret: SECRET,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
  });

  it('allows a little clock drift either way', () => {
    // Two servers disagreeing by thirty seconds must not lose a driver's
    // reply, which is a far more likely event than a replay.
    const justGone = Math.floor(NOW.getTime() / 1000) - 30;

    expect(
      verifyHttpSmsJwt({
        authorization: `Bearer ${sign({ exp: justGone })}`,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses nothing at all, and nonsense', () => {
    for (const authorization of [null, '', 'Bearer', 'Bearer not.a.jwt', 'abc']) {
      expect(
        verifyHttpSmsJwt({ authorization, secret: SECRET, now: NOW }).ok,
        String(authorization),
      ).toBe(false);
    }
  });
});

describe('inboundTextFrom', () => {
  const received = {
    type: 'message.phone.received',
    data: {
      contact: '+447700900123',
      content: 'Outside arrivals, door 4',
      message_id: '0b0123bb-ef2e-468f-908a-c026d51636aa',
      owner: '+447700900999',
      timestamp: '2026-10-17T11:59:00.000Z',
    },
  };

  it('reads a received text', () => {
    const text = inboundTextFrom(received);

    expect(text).toEqual({
      // `contact` is the driver's number; `owner` is the office's gateway
      // phone. Getting those the wrong way round would look for a driver by
      // the office's own number and never find one.
      from: '+447700900123',
      body: 'Outside arrivals, door 4',
      providerId: '0b0123bb-ef2e-468f-908a-c026d51636aa',
      receivedAt: new Date('2026-10-17T11:59:00.000Z'),
    });
  });

  it('ignores an event it does not act on', () => {
    /*
     * Null rather than throwing, so the handler answers 200. httpSMS retries a
     * 5xx four times and then gives up, which would turn one ignored delivery
     * receipt into five.
     */
    expect(inboundTextFrom({ ...received, type: 'message.phone.sent' })).toBeNull();
    expect(inboundTextFrom({ type: 'something.new' })).toBeNull();
  });

  it('ignores a shape it cannot read', () => {
    expect(inboundTextFrom(null)).toBeNull();
    expect(inboundTextFrom('a string')).toBeNull();
    expect(inboundTextFrom({ type: 'message.phone.received' })).toBeNull();
  });

  it('ignores an empty text, which has nothing to relay', () => {
    expect(
      inboundTextFrom({ ...received, data: { ...received.data, content: '   ' } }),
    ).toBeNull();
    expect(
      inboundTextFrom({ ...received, data: { ...received.data, contact: '' } }),
    ).toBeNull();
  });

  it('falls back to now when the timestamp is unusable', () => {
    const text = inboundTextFrom({
      ...received,
      data: { ...received.data, timestamp: 'not a date' },
    });

    expect(text?.receivedAt).toBeInstanceOf(Date);
  });
});
