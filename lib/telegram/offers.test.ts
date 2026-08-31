import { describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback } from './protocol';

/**
 * The offer button, before it reaches a database.
 *
 * Small on purpose — the part of this feature worth testing is the race, and
 * that needs Postgres, so it lives in `offers.integration.test.ts`. What is
 * here is the one thing that would break the feature silently rather than
 * loudly: a callback string that does not survive the round trip means every
 * tap on every offer comes back "that button is no longer valid", and nothing
 * anywhere reports a fault.
 */
describe('the offer button', () => {
  it('round-trips', () => {
    expect(decodeCallback(encodeCallback({ kind: 'offer-accept', jobId: 'job_1' }))).toEqual(
      { kind: 'offer-accept', jobId: 'job_1' },
    );
  });

  it('fits a real cuid inside Telegram’s 64 bytes', () => {
    const data = encodeCallback({
      kind: 'offer-accept',
      jobId: 'cmsxky07w008e7d6lqth1kmkx',
    });
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('does not collide with the accept a named driver taps', () => {
    /*
     * Two different accepts, and they must not be the same string.
     *
     * `accept` means "yes, I will do the job you gave me" and checks the job
     * is already this driver's. `offer-accept` means "I am claiming a job
     * nobody has" and assigns it. Decoding one as the other would either
     * refuse every claim — the job is not yours, because that is the whole
     * point — or hand out an unoffered job to whoever tapped.
     */
    const jobId = 'job_1';
    expect(encodeCallback({ kind: 'offer-accept', jobId })).not.toBe(
      encodeCallback({ kind: 'accept', jobId }),
    );
    expect(decodeCallback(encodeCallback({ kind: 'accept', jobId }))).toEqual({
      kind: 'accept',
      jobId,
    });
  });
});
