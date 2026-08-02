import { describe, expect, it } from 'vitest';
import {
  daysBetweenDates,
  endOfExpiryDay,
  endOfZonedDay,
  formatDate,
  formatDateTime,
  fromDateOnlyString,
  getPartsInZone,
  isDST,
  minutesBetween,
  startOfZonedDay,
  toDateOnlyString,
  toLondon,
  toUTC,
  zoneOffsetMs,
} from './dates';

const HOUR = 3600000;

/**
 * 2026 British Summer Time:
 *   starts Sunday 29 March  — 01:00 UTC becomes 02:00 BST
 *   ends   Sunday 25 October — 01:00 UTC, 02:00 BST becomes 01:00 GMT
 */

describe('zoneOffsetMs', () => {
  it('is zero in London in winter', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'))).toBe(0);
  });

  it('is one hour in London in summer', () => {
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'))).toBe(HOUR);
  });

  it('flips exactly at the March transition', () => {
    expect(zoneOffsetMs(new Date('2026-03-29T00:59:59Z'))).toBe(0);
    expect(zoneOffsetMs(new Date('2026-03-29T01:00:00Z'))).toBe(HOUR);
  });

  it('flips back exactly at the October transition', () => {
    expect(zoneOffsetMs(new Date('2026-10-25T00:59:59Z'))).toBe(HOUR);
    expect(zoneOffsetMs(new Date('2026-10-25T01:00:00Z'))).toBe(0);
  });
});

describe('isDST', () => {
  it('distinguishes GMT from BST', () => {
    expect(isDST(new Date('2026-01-15T12:00:00Z'))).toBe(false);
    expect(isDST(new Date('2026-07-15T12:00:00Z'))).toBe(true);
  });
});

describe('toUTC', () => {
  it('treats a winter booking as GMT', () => {
    expect(toUTC('2026-01-15T14:30').toISOString()).toBe(
      '2026-01-15T14:30:00.000Z',
    );
  });

  it('takes an hour off a summer booking, because London is on BST', () => {
    // The single most consequential line in this file. A 14:30 August pickup
    // is 13:30 UTC; storing 14:30 puts the driver at Heathrow an hour late.
    expect(toUTC('2026-08-02T14:30').toISOString()).toBe(
      '2026-08-02T13:30:00.000Z',
    );
  });

  it('accepts seconds and a space separator', () => {
    expect(toUTC('2026-08-02T14:30:15').toISOString()).toBe(
      '2026-08-02T13:30:15.000Z',
    );
    expect(toUTC('2026-08-02 14:30').toISOString()).toBe(
      '2026-08-02T13:30:00.000Z',
    );
  });

  it('defaults a bare date to midnight local', () => {
    expect(toUTC('2026-08-02').toISOString()).toBe('2026-08-01T23:00:00.000Z');
  });

  describe('across the March transition (clocks forward)', () => {
    it('handles the hour before', () => {
      expect(toUTC('2026-03-29T00:30').toISOString()).toBe(
        '2026-03-29T00:30:00.000Z',
      );
    });

    it('handles the hour after', () => {
      expect(toUTC('2026-03-29T03:30').toISOString()).toBe(
        '2026-03-29T02:30:00.000Z',
      );
    });

    it('shifts a time that never existed forward past the gap', () => {
      // 01:30 on 29 March 2026 does not occur in London.
      const shifted = toUTC('2026-03-29T01:30');
      expect(shifted.toISOString()).toBe('2026-03-29T01:30:00.000Z');
      expect(toLondon(shifted)).toBe('2026-03-29T02:30');
    });
  });

  describe('across the October transition (clocks back)', () => {
    it('handles the hour before', () => {
      expect(toUTC('2026-10-25T00:30').toISOString()).toBe(
        '2026-10-24T23:30:00.000Z',
      );
    });

    it('handles the hour after', () => {
      expect(toUTC('2026-10-25T03:30').toISOString()).toBe(
        '2026-10-25T03:30:00.000Z',
      );
    });

    it('resolves an ambiguous time to the second, post-transition occurrence', () => {
      // 01:30 happens twice on 25 October 2026. We take the GMT one.
      const resolved = toUTC('2026-10-25T01:30');
      expect(resolved.toISOString()).toBe('2026-10-25T01:30:00.000Z');
      expect(toLondon(resolved)).toBe('2026-10-25T01:30');
    });
  });

  it('rejects a malformed string rather than guessing', () => {
    expect(() => toUTC('02/08/2026 14:30')).toThrow(RangeError);
    expect(() => toUTC('')).toThrow(RangeError);
  });

  it('honours a non-London zone, so a non-UK install is configuration', () => {
    expect(toUTC('2026-08-02T14:30', 'America/New_York').toISOString()).toBe(
      '2026-08-02T18:30:00.000Z',
    );
    expect(toUTC('2026-08-02T14:30', 'UTC').toISOString()).toBe(
      '2026-08-02T14:30:00.000Z',
    );
  });
});

describe('toLondon', () => {
  it('adds an hour back on in summer', () => {
    expect(toLondon(new Date('2026-08-02T13:30:00Z'))).toBe('2026-08-02T14:30');
  });

  it('leaves winter instants alone', () => {
    expect(toLondon(new Date('2026-01-15T14:30:00Z'))).toBe('2026-01-15T14:30');
  });

  it('round-trips with toUTC across both transitions', () => {
    const wallClocks = [
      '2026-01-15T14:30',
      '2026-03-28T23:45',
      '2026-03-29T03:30',
      '2026-06-21T00:00',
      '2026-08-02T14:30',
      '2026-10-25T03:30',
      '2026-12-31T23:59',
    ];
    for (const wallClock of wallClocks) {
      expect(toLondon(toUTC(wallClock))).toBe(wallClock);
    }
  });
});

describe('getPartsInZone', () => {
  it('reads the local wall clock', () => {
    expect(getPartsInZone(new Date('2026-08-02T13:30:45Z'))).toEqual({
      year: 2026,
      month: 8,
      day: 2,
      hour: 14,
      minute: 30,
      second: 45,
    });
  });

  it('reports midnight as hour 0, not hour 24', () => {
    expect(getPartsInZone(new Date('2026-01-15T00:00:00Z')).hour).toBe(0);
  });
});

describe('startOfZonedDay / endOfZonedDay', () => {
  it('brackets a summer day at 23:00 UTC either side', () => {
    const midday = new Date('2026-08-02T13:30:00Z');
    expect(startOfZonedDay(midday).toISOString()).toBe(
      '2026-08-01T23:00:00.000Z',
    );
    expect(endOfZonedDay(midday).toISOString()).toBe(
      '2026-08-02T23:00:00.000Z',
    );
  });

  it('brackets a winter day at midnight UTC', () => {
    const midday = new Date('2026-01-15T12:00:00Z');
    expect(startOfZonedDay(midday).toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(endOfZonedDay(midday).toISOString()).toBe(
      '2026-01-16T00:00:00.000Z',
    );
  });

  it('gives the 23-hour day when clocks go forward', () => {
    const during = new Date('2026-03-29T12:00:00Z');
    const start = startOfZonedDay(during);
    const end = endOfZonedDay(during);
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });

  it('gives the 25-hour day when clocks go back', () => {
    const during = new Date('2026-10-25T12:00:00Z');
    const start = startOfZonedDay(during);
    const end = endOfZonedDay(during);
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR);
  });
});

describe('date-only columns', () => {
  it('round-trips without shifting a day', () => {
    expect(toDateOnlyString(fromDateOnlyString('2026-07-14'))).toBe(
      '2026-07-14',
    );
  });

  it('does not drift for a summer date', () => {
    expect(toDateOnlyString(fromDateOnlyString('2026-08-02'))).toBe(
      '2026-08-02',
    );
  });

  it('rejects a malformed date', () => {
    expect(() => fromDateOnlyString('14/07/2026')).toThrow(RangeError);
  });
});

describe('endOfExpiryDay', () => {
  it('keeps a document valid through the end of its expiry date', () => {
    // A PHV badge expiring 14 July is valid all of 14 July, London time.
    const validUntil = endOfExpiryDay(fromDateOnlyString('2026-07-14'));
    expect(validUntil.toISOString()).toBe('2026-07-14T23:00:00.000Z');

    const lastMomentValid = new Date('2026-07-14T22:59:59Z'); // 23:59:59 BST
    const firstMomentInvalid = new Date('2026-07-14T23:00:00Z'); // 00:00 on the 15th
    expect(lastMomentValid.getTime() < validUntil.getTime()).toBe(true);
    expect(firstMomentInvalid.getTime() < validUntil.getTime()).toBe(false);
  });

  it('works for a winter expiry, where local midnight is UTC midnight', () => {
    const validUntil = endOfExpiryDay(fromDateOnlyString('2026-01-31'));
    expect(validUntil.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('minutesBetween', () => {
  it('counts whole minutes, floored', () => {
    expect(
      minutesBetween(
        new Date('2026-08-02T13:30:00Z'),
        new Date('2026-08-02T14:15:00Z'),
      ),
    ).toBe(45);
    expect(
      minutesBetween(
        new Date('2026-08-02T13:30:00Z'),
        new Date('2026-08-02T13:30:59Z'),
      ),
    ).toBe(0);
  });

  it('is negative when the events are out of order', () => {
    expect(
      minutesBetween(
        new Date('2026-08-02T14:00:00Z'),
        new Date('2026-08-02T13:00:00Z'),
      ),
    ).toBe(-60);
  });
});

describe('daysBetweenDates', () => {
  it('counts calendar days, not 24-hour blocks', () => {
    // 23:30 to 00:30 is one hour but a different day.
    expect(
      daysBetweenDates(
        new Date('2026-08-02T22:30:00Z'),
        new Date('2026-08-02T23:30:00Z'),
      ),
    ).toBe(1);
  });

  it('is negative for a lapsed document', () => {
    expect(
      daysBetweenDates(
        new Date('2026-08-02T12:00:00Z'),
        new Date('2026-07-14T12:00:00Z'),
      ),
    ).toBe(-19);
  });

  it('spans a DST transition without gaining or losing a day', () => {
    expect(
      daysBetweenDates(
        new Date('2026-03-28T12:00:00Z'),
        new Date('2026-03-30T12:00:00Z'),
      ),
    ).toBe(2);
  });
});

describe('display formatting', () => {
  it('renders a job time in London', () => {
    expect(formatDateTime(new Date('2026-08-02T13:30:00Z'))).toBe(
      '2 Aug 2026, 14:30',
    );
  });

  it('renders a date', () => {
    expect(formatDate(new Date('2026-08-02T13:30:00Z'))).toBe('2 Aug 2026');
  });
});
