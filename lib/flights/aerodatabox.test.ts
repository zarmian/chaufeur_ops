import { describe, expect, it, vi } from 'vitest';
import { lookupFlight, mapFlight, mapState } from './aerodatabox';
import { blankFlightConfig } from './types';

/**
 * What this proves, and what it does not.
 *
 * It proves the mapping: that the shape AeroDataBox documents becomes the
 * shape `decide.ts` expects, that a status word nobody anticipated does not
 * quietly become "running normally", and that a failing call fails as a value
 * rather than an exception in a cron job at four in the morning.
 *
 * It does not prove the documentation. These fixtures were written from
 * AeroDataBox's published response shape, not captured from a live call —
 * this install has no key. One real call before switching a customer on will
 * either confirm them or correct them, and that is a step somebody has to do.
 */

const CONFIG = { ...blankFlightConfig(), enabled: true, apiKey: 'test-key' };

function leg(over: Record<string, unknown> = {}) {
  return {
    number: 'BA 117',
    status: 'EnRoute',
    departure: { airport: { iata: 'JFK', name: 'New York John F Kennedy' } },
    arrival: {
      airport: { iata: 'LHR', name: 'London Heathrow' },
      terminal: '5',
      scheduledTime: {
        utc: '2026-09-15 06:00Z',
        local: '2026-09-15 07:00+01:00',
      },
      revisedTime: {
        utc: '2026-09-15 07:30Z',
        local: '2026-09-15 08:30+01:00',
      },
    },
    ...over,
  };
}

function ok(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('mapFlight', () => {
  it('turns a leg into the report the decision needs', () => {
    const report = mapFlight([leg()], 'BA117');

    expect(report).toEqual({
      flightNumber: 'BA117',
      state: 'ACTIVE',
      scheduledArrival: new Date('2026-09-15T06:00:00Z'),
      estimatedArrival: new Date('2026-09-15T07:30:00Z'),
      actualArrival: null,
      origin: 'JFK',
      destination: 'LHR',
      terminal: '5',
    });
  });

  it('reads the UTC time and never the local one', () => {
    /*
     * The local string carries the airport's offset. Read as if it were UTC
     * it is an hour out at Heathrow in summer — the exact size of error that
     * puts a driver at the gate an hour early and nobody spots until then.
     */
    const report = mapFlight([leg()], 'BA117');
    expect(report?.scheduledArrival?.toISOString()).toBe(
      '2026-09-15T06:00:00.000Z',
    );
  });

  it('prefers a real landing time over the estimate', () => {
    const report = mapFlight(
      [
        leg({
          status: 'Arrived',
          arrival: {
            ...leg().arrival,
            actualTime: { utc: '2026-09-15 07:12Z' },
          },
        }),
      ],
      'BA117',
    );

    expect(report?.state).toBe('LANDED');
    expect(report?.actualArrival?.toISOString()).toBe(
      '2026-09-15T07:12:00.000Z',
    );
  });

  it('takes the earliest arriving leg when a number returns several', () => {
    // Meeting the wrong sector of a multi-leg service is a car at an empty
    // gate, so the tie is broken rather than left to whatever order the
    // provider happened to send.
    const later = leg({
      arrival: {
        ...leg().arrival,
        scheduledTime: { utc: '2026-09-15 18:00Z' },
      },
    });
    const earlier = leg({
      arrival: {
        ...leg().arrival,
        scheduledTime: { utc: '2026-09-15 06:00Z' },
      },
    });

    const report = mapFlight([later, earlier], 'BA117');
    expect(report?.scheduledArrival?.toISOString()).toBe(
      '2026-09-15T06:00:00.000Z',
    );
  });

  it('survives a payload with the fields missing', () => {
    // A provider dropping a field must not throw inside a cron run.
    const report = mapFlight([{ status: 'Expected' }], 'BA117');

    expect(report).toMatchObject({
      state: 'SCHEDULED',
      scheduledArrival: null,
      estimatedArrival: null,
      destination: null,
    });
  });

  it('returns nothing for an empty answer', () => {
    expect(mapFlight([], 'BA117')).toBeNull();
    expect(mapFlight({}, 'BA117')).toBeNull();
  });
});

describe('mapState', () => {
  it('maps the states that change a decision', () => {
    expect(mapState('Expected')).toBe('SCHEDULED');
    expect(mapState('EnRoute')).toBe('ACTIVE');
    expect(mapState('Arrived')).toBe('LANDED');
    expect(mapState('Canceled')).toBe('CANCELLED');
    expect(mapState('Diverted')).toBe('DIVERTED');
  });

  it('calls anything it does not recognise unknown', () => {
    /*
     * The safe direction. A status nobody anticipated falling through to
     * "scheduled" would present a cancelled flight as running normally, and
     * `decide.ts` would hold rather than flag.
     */
    expect(mapState('SomethingNew')).toBe('UNKNOWN');
    expect(mapState(null)).toBe('UNKNOWN');
    expect(mapState(42)).toBe('UNKNOWN');
  });
});

describe('lookupFlight', () => {
  it('sends the key and the host the way RapidAPI wants them', async () => {
    const fetchImpl = ok([leg()]);
    await lookupFlight(CONFIG, 'BA117', '2026-09-15', fetchImpl);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];

    expect(url).toContain('/flights/number/BA117/2026-09-15');
    expect((init.headers as Record<string, string>)['x-rapidapi-key']).toBe(
      'test-key',
    );
    expect(
      (init.headers as Record<string, string>)['x-rapidapi-host'],
    ).toContain('aerodatabox');
  });

  it('treats “no such flight that day” as an answer, not a fault', async () => {
    // An operator typing a number that does not fly on a Tuesday is a
    // data-quality problem. Logging it as an outage would bury the real ones.
    const result = await lookupFlight(
      CONFIG,
      'BA117',
      '2026-09-15',
      ok({}, 404),
    );

    expect(result).toEqual({ ok: true, value: null });
  });

  it('reports a refused key as a failure with its status', async () => {
    const result = await lookupFlight(
      CONFIG,
      'BA117',
      '2026-09-15',
      ok({}, 403),
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'HTTP_403' });
  });

  it('returns a value rather than throwing when the network is gone', async () => {
    // This runs on a schedule with nobody watching. An exception here would
    // take the whole run down and skip every other flight in it.
    const dead = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const result = await lookupFlight(CONFIG, 'BA117', '2026-09-15', dead);

    expect(result).toMatchObject({ ok: false, code: 'UNREACHABLE' });
  });

  it('refuses to call without a key', async () => {
    const fetchImpl = ok([leg()]);
    const result = await lookupFlight(
      { ...CONFIG, apiKey: null },
      'BA117',
      '2026-09-15',
      fetchImpl,
    );

    expect(result).toMatchObject({ ok: false, code: 'NO_KEY' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
