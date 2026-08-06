import { describe, expect, it, vi } from 'vitest';
import { segmentsFor, sendSms, smsConfigured, toE164, type SmsConfig } from './sms';

/**
 * Texting a client.
 *
 * The rule worth guarding is the refusal. A number this cannot parse is not
 * guessed at: a text to a wrong number is a text to a stranger, and the
 * client never learns their booking was confirmed to somebody else.
 */

const TWILIO: SmsConfig = {
  provider: 'twilio',
  accountSid: 'AC123',
  authToken: 'secret-token',
  fromNumber: '+441234567890',
};

function respondWith(body: unknown, ok = true) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 201 : 400,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('toE164', () => {
  it.each([
    ['07700900123', '+447700900123'],
    ['07700 900123', '+447700900123'],
    ['+44 7700 900123', '+447700900123'],
    ['447700900123', '+447700900123'],
  ])('%s becomes %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it('refuses anything it does not recognise rather than guessing', () => {
    for (const input of ['', '12345', '0770090012', 'not a number', null, undefined]) {
      expect(toE164(input)).toBeNull();
    }
  });
});

describe('smsConfigured', () => {
  it('needs all three fields', () => {
    expect(smsConfigured(TWILIO)).toBe(true);
    expect(smsConfigured({ ...TWILIO, authToken: null })).toBe(false);
    expect(smsConfigured({ ...TWILIO, provider: 'none' })).toBe(false);
  });
});

describe('segmentsFor', () => {
  it('counts a plain message as one segment up to 160', () => {
    expect(segmentsFor('a'.repeat(160))).toEqual({ segments: 1, unicode: false });
    expect(segmentsFor('a'.repeat(161)).segments).toBe(2);
  });

  it('notices a single non-GSM character, which quadruples the bill', () => {
    // A curly apostrophe pasted from a document drops the limit to 70, and
    // nothing about the message looks different.
    const plain = segmentsFor('a'.repeat(100));
    const curly = segmentsFor(`${'a'.repeat(99)}’`);

    expect(plain).toEqual({ segments: 1, unicode: false });
    expect(curly.unicode).toBe(true);
    expect(curly.segments).toBe(2);
  });
});

describe('sendSms', () => {
  it('sends to the normalised number', async () => {
    const fetchImpl = respondWith({ sid: 'SM123' });
    const result = await sendSms(TWILIO, '07700 900123', 'Your car is booked.', {
      fetchImpl,
    });

    expect(result.sent).toBe(true);
    if (result.sent) expect(result.providerId).toBe('SM123');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get('To')).toBe('+447700900123');
    expect(body.get('From')).toBe('+441234567890');
  });

  it('keeps the token in the header, never the URL', async () => {
    // A token in a query string ends up in every proxy log on the way.
    const fetchImpl = respondWith({ sid: 'SM123' });
    await sendSms(TWILIO, '07700900123', 'hello', { fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).not.toContain('secret-token');
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toMatch(/^Basic /);
  });

  it('refuses a number it cannot read, without calling anybody', async () => {
    const fetchImpl = respondWith({ sid: 'SM123' });
    const result = await sendSms(TWILIO, 'ring the office', 'hello', { fetchImpl });

    expect(result.sent).toBe(false);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('refuses when nothing is configured', async () => {
    const result = await sendSms(
      { provider: 'none', accountSid: null, authToken: null, fromNumber: null },
      '07700900123',
      'hello',
    );
    expect(result.sent).toBe(false);
    expect(result.message).toContain('No SMS provider');
  });

  it('reports Twilio’s own message, because the fixes differ', async () => {
    // "Unverified number" and "insufficient funds" need different actions,
    // and "send failed" needs none anybody can take.
    const result = await sendSms(
      TWILIO,
      '07700900123',
      'hello',
      { fetchImpl: respondWith({ message: 'The number is unverified', code: 21608 }, false) },
    );

    expect(result.sent).toBe(false);
    expect(result.message).toContain('unverified');
  });

  it('returns rather than throwing when Twilio is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await sendSms(TWILIO, '07700900123', 'hello', { fetchImpl });
    expect(result.sent).toBe(false);
    expect(result.message).toContain('network down');
  });
});
