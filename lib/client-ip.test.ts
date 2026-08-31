import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './rate-limit';

/**
 * Which address the throttle keys on.
 *
 * This is not a formatting detail. The login limiter used to read the *first*
 * entry of `X-Forwarded-For`, which is the one the client writes — so the key
 * the throttle counted against was chosen by the person being throttled.
 * Demonstrated rather than theorised: rotating the header gave seven attempts
 * against one account without ever being refused, against a limit of five.
 *
 * The rule is the opposite end. `X-Forwarded-For` is appended left to right,
 * so the rightmost entry is what the nearest trusted proxy wrote, and a
 * client cannot influence it — anything they send gets another entry appended
 * after it.
 */

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('clientIpFrom', () => {
  it('takes the entry the proxy appended, not the one the client sent', () => {
    // The client claimed 1.1.1.1; the proxy recorded 203.0.113.9. Only the
    // second is a fact.
    expect(
      clientIpFrom(headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })),
    ).toBe('203.0.113.9');
  });

  it('cannot be moved by a client stuffing the header', () => {
    /*
     * The bypass, written out. Every one of these is a request where the
     * attacker has tried to name their own bucket, and every one must still
     * key on the address the proxy observed.
     */
    const spoofs = [
      '203.0.113.1',
      '203.0.113.2, 203.0.113.3',
      'not-an-ip',
      '::1, 127.0.0.1, 10.0.0.1',
    ];

    for (const claim of spoofs) {
      expect(
        clientIpFrom(headers({ 'x-forwarded-for': `${claim}, 198.51.100.7` })),
        claim,
      ).toBe('198.51.100.7');
    }
  });

  it('handles a single entry, which is what one proxy usually sends', () => {
    expect(clientIpFrom(headers({ 'x-forwarded-for': '198.51.100.7' }))).toBe(
      '198.51.100.7',
    );
  });

  it('tolerates whitespace and empty entries', () => {
    expect(
      clientIpFrom(headers({ 'x-forwarded-for': ' 1.1.1.1 , , 198.51.100.7 ' })),
    ).toBe('198.51.100.7');
  });

  it('falls back to x-real-ip, then to a stable unknown', () => {
    expect(clientIpFrom(headers({ 'x-real-ip': '198.51.100.8' }))).toBe(
      '198.51.100.8',
    );
    // A constant rather than a random value: every unidentifiable request
    // shares one bucket, which is the conservative direction.
    expect(clientIpFrom(headers({}))).toBe('unknown');
  });
});
