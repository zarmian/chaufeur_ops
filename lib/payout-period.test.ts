import { describe, expect, it } from 'vitest';
import { formatDateTime } from './dates';
import {
  currentPayoutWeek,
  lastFullPayoutWeek,
  payoutWeekOf,
} from './payout-period';

/**
 * The payout week, and the summer hour it used to lose.
 *
 * These read as wall clock in London deliberately: the whole point of the
 * module is that the boundary is a local one, and asserting on UTC instants
 * would let a bug in the conversion agree with a bug in the test.
 */

const LONDON = 'Europe/London';

/** `2026-09-01T09:00:00Z` becomes `01 Sept 2026, 10:00` — the local reading. */
function london(instant: Date): string {
  return formatDateTime(instant, { locale: 'en-GB', timeZone: LONDON });
}

describe('payoutWeekOf', () => {
  it('runs local Monday midnight to local Sunday midnight-less-a-millisecond', () => {
    // A Wednesday in September, on BST.
    const week = payoutWeekOf(new Date('2026-09-02T12:00:00Z'), LONDON);

    expect(london(week.from)).toBe('31 Aug 2026, 00:00');
    expect(london(week.to)).toBe('6 Sept 2026, 23:59');
  });

  it('keeps a Monday in its own week rather than the one before', () => {
    const week = payoutWeekOf(new Date('2026-08-31T08:00:00Z'), LONDON);
    expect(london(week.from)).toBe('31 Aug 2026, 00:00');
  });

  it('keeps a Sunday in its own week rather than the one after', () => {
    const week = payoutWeekOf(new Date('2026-09-06T22:00:00Z'), LONDON);
    expect(london(week.from)).toBe('31 Aug 2026, 00:00');
    expect(london(week.to)).toBe('6 Sept 2026, 23:59');
  });

  it('puts an early-hours summer Monday in the week it was worked', () => {
    /*
     * The regression this module exists for. A 00:30 airport run on Monday
     * 31 August is 23:30 UTC on the Sunday, and a boundary computed in UTC
     * put it in the week before — paid out a week early, on a statement
     * covering the days either side of it.
     */
    const earlyMonday = new Date('2026-08-30T23:30:00Z');
    expect(london(earlyMonday)).toBe('31 Aug 2026, 00:30');

    const week = payoutWeekOf(earlyMonday, LONDON);
    expect(london(week.from)).toBe('31 Aug 2026, 00:00');
    expect(week.from.getTime()).toBeLessThanOrEqual(earlyMonday.getTime());
    expect(week.to.getTime()).toBeGreaterThan(earlyMonday.getTime());
  });

  it('holds the boundary across the clocks going back', () => {
    // BST ends 05:00 UTC on Sunday 25 October 2026, inside this week.
    const week = payoutWeekOf(new Date('2026-10-21T12:00:00Z'), LONDON);

    expect(london(week.from)).toBe('19 Oct 2026, 00:00');
    expect(london(week.to)).toBe('25 Oct 2026, 23:59');

    // 169 hours, because one of them happened twice.
    const hours = (week.to.getTime() + 1 - week.from.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });

  it('holds the boundary across the clocks going forward', () => {
    // BST begins 01:00 UTC on Sunday 29 March 2026.
    const week = payoutWeekOf(new Date('2026-03-24T12:00:00Z'), LONDON);

    expect(london(week.from)).toBe('23 Mar 2026, 00:00');
    expect(london(week.to)).toBe('29 Mar 2026, 23:59');

    const hours = (week.to.getTime() + 1 - week.from.getTime()) / 3_600_000;
    expect(hours).toBe(167);
  });

  it('crosses a month and a year end without losing a day', () => {
    const week = payoutWeekOf(new Date('2027-01-01T12:00:00Z'), LONDON);
    expect(london(week.from)).toBe('28 Dec 2026, 00:00');
    expect(london(week.to)).toBe('3 Jan 2027, 23:59');
  });

  it('follows the configured zone rather than assuming London', () => {
    // Configured locale is a setting, so the boundary has to move with it.
    const week = payoutWeekOf(
      new Date('2026-09-02T12:00:00Z'),
      'America/New_York',
    );
    expect(
      formatDateTime(week.from, {
        locale: 'en-GB',
        timeZone: 'America/New_York',
      }),
    ).toBe('31 Aug 2026, 00:00');
  });
});

describe('lastFullPayoutWeek', () => {
  it('is the week before the one in progress, and they meet exactly', () => {
    const now = new Date('2026-09-02T12:00:00Z');
    const previous = lastFullPayoutWeek(now, LONDON);
    const current = currentPayoutWeek(now, LONDON);

    expect(london(previous.from)).toBe('24 Aug 2026, 00:00');
    expect(london(previous.to)).toBe('30 Aug 2026, 23:59');

    // No gap and no overlap: every job belongs to exactly one week.
    expect(previous.to.getTime() + 1).toBe(current.from.getTime());
  });

  it('on a Monday, looks back at the week that just ended', () => {
    const previous = lastFullPayoutWeek(
      new Date('2026-08-31T09:00:00Z'),
      LONDON,
    );
    expect(london(previous.from)).toBe('24 Aug 2026, 00:00');
    expect(london(previous.to)).toBe('30 Aug 2026, 23:59');
  });
});
