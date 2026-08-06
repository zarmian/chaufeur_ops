import { describe, expect, it } from 'vitest';
import { toLondon, toUTC } from './dates';
import {
  describeRule,
  expandRecurrence,
  MAX_OCCURRENCES,
  RecurrenceError,
  suggestReturnAt,
  type RecurrenceRule,
} from './recurrence';

const LONDON = 'Europe/London';

/** The wall-clock readings the occurrences land on, which is what an operator sees. */
const wall = (dates: Date[]) => dates.map((date) => toLondon(date, LONDON));

const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  frequency: 'DAILY',
  interval: 1,
  startsAt: toUTC('2026-09-01T09:00', LONDON),
  count: 3,
  ...over,
});

describe('expandRecurrence', () => {
  it('includes the first occurrence in the count', () => {
    // "Five occurrences" means five jobs, not the first plus five.
    const dates = expandRecurrence(rule({ count: 5 }), LONDON);
    expect(dates).toHaveLength(5);
    expect(wall(dates)[0]).toBe('2026-09-01T09:00');
  });

  it('walks days for a daily rule', () => {
    expect(wall(expandRecurrence(rule({ count: 3 }), LONDON))).toEqual([
      '2026-09-01T09:00',
      '2026-09-02T09:00',
      '2026-09-03T09:00',
    ]);
  });

  it('honours an interval', () => {
    expect(wall(expandRecurrence(rule({ interval: 3, count: 3 }), LONDON))).toEqual([
      '2026-09-01T09:00',
      '2026-09-04T09:00',
      '2026-09-07T09:00',
    ]);
  });

  it('stops at an end date, inclusive of that day', () => {
    // "Until the 3rd" includes the 3rd, whatever time of day the series runs.
    const dates = expandRecurrence(
      rule({ count: null, until: toUTC('2026-09-03T00:00', LONDON) }),
      LONDON,
    );
    expect(wall(dates)).toEqual([
      '2026-09-01T09:00',
      '2026-09-02T09:00',
      '2026-09-03T09:00',
    ]);
  });

  describe('weekly', () => {
    it('repeats on the start’s weekday when none are chosen', () => {
      // 1 September 2026 is a Tuesday.
      const dates = expandRecurrence(
        rule({ frequency: 'WEEKLY', count: 3 }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-09-01T09:00',
        '2026-09-08T09:00',
        '2026-09-15T09:00',
      ]);
    });

    it('fires on every chosen day of the week', () => {
      // Monday and Thursday, starting Tuesday 1 September.
      const dates = expandRecurrence(
        rule({ frequency: 'WEEKLY', weekdays: [1, 4], count: 4 }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-09-03T09:00', // Thursday of the first week
        '2026-09-07T09:00', // Monday
        '2026-09-10T09:00', // Thursday
        '2026-09-14T09:00', // Monday
      ]);
    });

    it('never produces an occurrence before the start', () => {
      // Monday is earlier in the week than the Tuesday start, so the first
      // week contributes only Thursday.
      const dates = expandRecurrence(
        rule({ frequency: 'WEEKLY', weekdays: [1, 4], count: 1 }),
        LONDON,
      );
      expect(wall(dates)).toEqual(['2026-09-03T09:00']);
    });

    it('keeps a fortnightly pair on the same two days', () => {
      // Anchored to the week, not to the first occurrence — otherwise the
      // pattern drifts depending on which day was booked first.
      const dates = expandRecurrence(
        rule({ frequency: 'WEEKLY', interval: 2, weekdays: [1, 4], count: 4 }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-09-03T09:00',
        '2026-09-14T09:00',
        '2026-09-17T09:00',
        '2026-09-28T09:00',
      ]);
    });
  });

  describe('monthly', () => {
    it('keeps the day of the month', () => {
      const dates = expandRecurrence(
        rule({
          frequency: 'MONTHLY',
          startsAt: toUTC('2026-09-15T09:00', LONDON),
          count: 3,
        }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-09-15T09:00',
        '2026-10-15T09:00',
        '2026-11-15T09:00',
      ]);
    });

    it('skips a month that has no such day rather than moving the job', () => {
      // The 31st of February is not the 28th. A car outside a hotel on a day
      // nobody chose is worse than a gap the operator can see.
      const dates = expandRecurrence(
        rule({
          frequency: 'MONTHLY',
          startsAt: toUTC('2026-12-31T09:00', LONDON),
          count: 3,
        }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-12-31T09:00',
        '2027-01-31T09:00',
        '2027-03-31T09:00', // February skipped
      ]);
    });

    it('crosses a year boundary', () => {
      const dates = expandRecurrence(
        rule({
          frequency: 'MONTHLY',
          startsAt: toUTC('2026-11-10T09:00', LONDON),
          count: 3,
        }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-11-10T09:00',
        '2026-12-10T09:00',
        '2027-01-10T09:00',
      ]);
    });
  });

  describe('British Summer Time', () => {
    it('holds the wall clock across the spring transition', () => {
      // The whole reason this module works in civil dates. Clocks go forward
      // on 29 March 2026; adding 24 hours of elapsed time to the 28th gives
      // 10:00 on the 29th, and an airport transfer an hour late is a missed
      // flight.
      const dates = expandRecurrence(
        rule({ startsAt: toUTC('2026-03-28T09:00', LONDON), count: 3 }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-03-28T09:00',
        '2026-03-29T09:00',
        '2026-03-30T09:00',
      ]);
    });

    it('holds the wall clock across the autumn transition', () => {
      // Clocks go back on 25 October 2026.
      const dates = expandRecurrence(
        rule({ startsAt: toUTC('2026-10-24T09:00', LONDON), count: 3 }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-10-24T09:00',
        '2026-10-25T09:00',
        '2026-10-26T09:00',
      ]);
    });

    it('shifts the UTC instant by an hour across the transition', () => {
      // The other side of the same coin: holding the wall clock means the
      // stored instant must change. 09:00 is 09:00Z in winter and 08:00Z in
      // summer, and a series that stored the same UTC time throughout would
      // be the bug.
      const dates = expandRecurrence(
        rule({ startsAt: toUTC('2026-03-28T09:00', LONDON), count: 2 }),
        LONDON,
      );
      expect(dates[0]!.toISOString()).toBe('2026-03-28T09:00:00.000Z');
      expect(dates[1]!.toISOString()).toBe('2026-03-29T08:00:00.000Z');
    });

    it('holds a weekly series across the transition too', () => {
      const dates = expandRecurrence(
        rule({
          frequency: 'WEEKLY',
          startsAt: toUTC('2026-03-22T07:30', LONDON),
          count: 3,
        }),
        LONDON,
      );
      expect(wall(dates)).toEqual([
        '2026-03-22T07:30',
        '2026-03-29T07:30',
        '2026-04-05T07:30',
      ]);
    });
  });

  describe('refusals', () => {
    it('refuses a recurrence with no end', () => {
      // Not a long series — an unanswered question. Defaulting it would put
      // jobs on the board nobody chose.
      expect(() =>
        expandRecurrence(rule({ count: null, until: null }), LONDON),
      ).toThrow(RecurrenceError);
    });

    it('refuses an interval of zero', () => {
      expect(() => expandRecurrence(rule({ interval: 0 }), LONDON)).toThrow(
        RecurrenceError,
      );
    });

    it('refuses an end date before the first occurrence', () => {
      expect(() =>
        expandRecurrence(
          rule({ count: null, until: toUTC('2026-08-01T09:00', LONDON) }),
          LONDON,
        ),
      ).toThrow(RecurrenceError);
    });

    it('caps a runaway series', () => {
      // "Daily until 2099" is a typo, and honouring it costs 27,000 jobs and
      // an unusable job list.
      const dates = expandRecurrence(
        rule({ count: null, until: toUTC('2099-01-01T09:00', LONDON) }),
        LONDON,
      );
      expect(dates).toHaveLength(MAX_OCCURRENCES);
    });

    it('caps an over-large explicit count', () => {
      const dates = expandRecurrence(rule({ count: 100_000 }), LONDON);
      expect(dates).toHaveLength(MAX_OCCURRENCES);
    });
  });

  it('produces occurrences in order, with no duplicates', () => {
    const dates = expandRecurrence(
      rule({ frequency: 'WEEKLY', weekdays: [1, 3, 5], count: 12 }),
      LONDON,
    );
    const times = dates.map((date) => date.getTime());

    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('ignores nonsense weekdays rather than producing invalid dates', () => {
    const dates = expandRecurrence(
      rule({ frequency: 'WEEKLY', weekdays: [1, 9, -2], count: 2 }),
      LONDON,
    );
    expect(wall(dates)).toEqual(['2026-09-07T09:00', '2026-09-14T09:00']);
  });
});

describe('describeRule', () => {
  it('reads as English for each frequency', () => {
    expect(describeRule(rule(), LONDON)).toBe('Every day');
    expect(describeRule(rule({ interval: 2 }), LONDON)).toBe('Every 2nd day');
    expect(describeRule(rule({ frequency: 'WEEKLY', weekdays: [1, 4] }), LONDON)).toBe(
      'Every week on Monday, Thursday',
    );
    expect(
      describeRule(
        rule({ frequency: 'MONTHLY', startsAt: toUTC('2026-09-03T09:00', LONDON) }),
        LONDON,
      ),
    ).toBe('Every month on the 3rd');
  });

  it('names the weekday of the start when none were chosen', () => {
    expect(describeRule(rule({ frequency: 'WEEKLY' }), LONDON)).toBe(
      'Every week on Tuesday',
    );
  });
});

describe('suggestReturnAt', () => {
  it('offers a few hours later', () => {
    const out = toUTC('2026-09-01T09:00', LONDON);
    expect(toLondon(suggestReturnAt(out), LONDON)).toBe('2026-09-01T12:00');
  });

  it('allows for the outbound journey when its length is known', () => {
    const out = toUTC('2026-09-01T09:00', LONDON);
    expect(toLondon(suggestReturnAt(out, 90), LONDON)).toBe('2026-09-01T13:30');
  });
});
