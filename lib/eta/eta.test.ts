import { describe, expect, it, vi } from 'vitest';
import { googleRoutesProvider } from './google';
import { straightLineProvider } from './straight-line';
import { describeMinutes, haversineMetres, isStale, pointFrom } from './types';

/**
 * The arithmetic and the phrasing, which are the parts a client reads.
 *
 * The number itself is an estimate and always will be. What must not vary is
 * that it is never presented as more certain than it is: no false precision,
 * no confident answer from a stale position, and no silence where a rough
 * figure would do.
 */

const SAVOY = { lat: 51.5101, lng: -0.1206 };
const HEATHROW_T5 = { lat: 51.4700, lng: -0.4890 };

describe('haversineMetres', () => {
  it('measures a known London distance', () => {
    // The Savoy to Heathrow T5 is about 25 km as the crow flies.
    const metres = haversineMetres(SAVOY, HEATHROW_T5);
    expect(metres).toBeGreaterThan(23_000);
    expect(metres).toBeLessThan(27_000);
  });

  it('is zero for the same point, and symmetric', () => {
    expect(haversineMetres(SAVOY, SAVOY)).toBeCloseTo(0);
    expect(haversineMetres(SAVOY, HEATHROW_T5)).toBeCloseTo(
      haversineMetres(HEATHROW_T5, SAVOY),
    );
  });
});

describe('describeMinutes', () => {
  it('bands rather than reporting false precision', () => {
    // A routing engine cannot know which lights are red. 13.4 minutes claims
    // it can.
    expect(describeMinutes(13.4)).toBe('about 15 minutes away');
    expect(describeMinutes(12)).toBe('about 10 minutes away');
  });

  it('gives two clients texted a minute apart the same answer', () => {
    expect(describeMinutes(16)).toBe(describeMinutes(17));
  });

  it('says arriving rather than a number when the car is on the street', () => {
    expect(describeMinutes(0)).toBe('arriving now');
    expect(describeMinutes(2)).toBe('arriving now');
  });

  it('never rounds down to zero minutes', () => {
    expect(describeMinutes(4)).toBe('about 5 minutes away');
  });

  it('stops counting past an hour and a half', () => {
    expect(describeMinutes(200)).toBe('over an hour away');
  });

  it('degrades to a word rather than NaN', () => {
    expect(describeMinutes(Number.NaN)).toBe('shortly');
    expect(describeMinutes(-5)).toBe('shortly');
  });
});

describe('isStale', () => {
  const now = new Date('2026-08-10T12:00:00.000Z');

  it('accepts a position from a moment ago', () => {
    expect(isStale(new Date('2026-08-10T11:58:00.000Z'), now)).toBe(false);
  });

  it('rejects one from before the driver lost signal', () => {
    // The phone stops sending and the last thing it said goes on looking
    // true. Past the threshold the honest answer is that we do not know.
    expect(isStale(new Date('2026-08-10T11:40:00.000Z'), now)).toBe(true);
  });
});

describe('pointFrom', () => {
  it('refuses half-populated and out-of-range coordinates', () => {
    expect(pointFrom(51.5, null)).toBeNull();
    expect(pointFrom(null, -0.12)).toBeNull();
    expect(pointFrom(91, 0)).toBeNull();
    expect(pointFrom(0, 181)).toBeNull();
    expect(pointFrom(Number.NaN, 0)).toBeNull();
  });

  it('accepts a real one', () => {
    expect(pointFrom(51.5101, -0.1206)).toEqual(SAVOY);
  });
});

describe('the straight-line provider', () => {
  it('answers without a key or a network', async () => {
    const estimate = await straightLineProvider().estimate(SAVOY, HEATHROW_T5);
    expect(estimate.source).toBe('straight-line');
    expect(estimate.trafficAware).toBe(false);
    // ~25km crow, ~32km by the winding factor, at 24km/h — over an hour.
    expect(estimate.minutes).toBeGreaterThan(60);
  });

  it('is pessimistic on purpose', async () => {
    // Early is a client glancing at the door; late is a client who was lied
    // to. A slower assumed speed must not produce a shorter estimate.
    const slow = await straightLineProvider({ kmh: 12 }).estimate(SAVOY, HEATHROW_T5);
    const fast = await straightLineProvider({ kmh: 48 }).estimate(SAVOY, HEATHROW_T5);
    expect(slow.minutes).toBeGreaterThan(fast.minutes);
  });
});

describe('the Google Routes provider', () => {
  const ok = (body: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => body } as Response);

  it('reads the duration Routes actually returns', async () => {
    const fetchImpl = ok({ routes: [{ duration: '737s', distanceMeters: 5400 }] });
    const estimate = await googleRoutesProvider({ apiKey: 'k', fetchImpl }).estimate(
      SAVOY,
      HEATHROW_T5,
    );

    expect(estimate?.minutes).toBeCloseTo(737 / 60);
    expect(estimate?.metres).toBe(5400);
    expect(estimate?.trafficAware).toBe(true);
  });

  it('asks for traffic, and only for the two fields it uses', async () => {
    // Routes bills by field mask. A polyline nobody draws is money spent on
    // bytes that get discarded.
    const fetchImpl = ok({ routes: [{ duration: '60s' }] });
    await googleRoutesProvider({ apiKey: 'k', fetchImpl }).estimate(SAVOY, HEATHROW_T5);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)['X-Goog-FieldMask']).toBe(
      'routes.duration,routes.distanceMeters',
    );
    expect(String(init!.body)).toContain('TRAFFIC_AWARE');
  });

  it('keeps the key in the header, never the query string', async () => {
    const fetchImpl = ok({ routes: [{ duration: '60s' }] });
    await googleRoutesProvider({ apiKey: 'secret-key', fetchImpl }).estimate(
      SAVOY,
      HEATHROW_T5,
    );

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain('secret-key');
    expect((init!.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('secret-key');
  });

  it('returns null rather than throwing when the provider is unhappy', async () => {
    // A rate-limited router must not become a client's missing text.
    const failed = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    expect(
      await googleRoutesProvider({ apiKey: 'k', fetchImpl: failed }).estimate(SAVOY, HEATHROW_T5),
    ).toBeNull();

    const threw = vi.fn().mockRejectedValue(new Error('socket hang up'));
    expect(
      await googleRoutesProvider({ apiKey: 'k', fetchImpl: threw }).estimate(SAVOY, HEATHROW_T5),
    ).toBeNull();
  });

  it('returns null on a shape it does not recognise', async () => {
    const odd = ok({ routes: [{ duration: 'about ten minutes' }] });
    expect(
      await googleRoutesProvider({ apiKey: 'k', fetchImpl: odd }).estimate(SAVOY, HEATHROW_T5),
    ).toBeNull();
  });
});
