import { describe, expect, it } from 'vitest';
import {
  addDays,
  contractSchema,
  datesToGenerate,
  describeWeekdays,
  MAX_GENERATE_AHEAD_DAYS,
  runsOn,
  weekdayOf,
} from './contracts';

/**
 * Which days a standing contract owes.
 *
 * The arithmetic is pure and done on `YYYY-MM-DD` strings on purpose: a
 * contract runs on calendar days in the operator's own zone, and doing it on
 * instants is how a clocks change turns Monday into Sunday.
 *
 * Two failures are worth more than the rest. Generating the same day twice
 * puts two cars at the school gates and bills the client for both. Generating
 * none quietly stops the arrangement, and nobody finds out until a morning
 * when the car does not arrive.
 */

const contract = (overrides: Partial<Parameters<typeof datesToGenerate>[0]> = {}) => ({
  startsOn: '2026-07-27', // a Monday
  endsOn: null,
  weekdays: [] as number[],
  generatedThroughOn: null as string | null,
  ...overrides,
});

describe('datesToGenerate', () => {
  it('books from the start date through the horizon', () => {
    expect(datesToGenerate(contract(), '2026-07-30')).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
    ]);
  });

  it('books only the weekdays it runs', () => {
    // Monday to Friday: the weekend is skipped rather than booked and
    // cancelled.
    expect(
      datesToGenerate(contract({ weekdays: [1, 2, 3, 4, 5] }), '2026-08-03'),
    ).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-03',
    ]);
  });

  it('creates nothing on a second run the same day', () => {
    // The watermark. Without it, every run would re-examine every day the
    // contract has ever covered.
    const already = contract({ generatedThroughOn: '2026-07-30' });
    expect(datesToGenerate(already, '2026-07-30')).toEqual([]);
  });

  it('picks up where it left off', () => {
    expect(
      datesToGenerate(contract({ generatedThroughOn: '2026-07-28' }), '2026-07-30'),
    ).toEqual(['2026-07-29', '2026-07-30']);
  });

  it('never books before the contract starts', () => {
    // A watermark behind the start — from a contract whose start was moved
    // forward — must not backfill days that were never owed.
    expect(
      datesToGenerate(
        contract({ startsOn: '2026-07-29', generatedThroughOn: '2026-07-20' }),
        '2026-07-31',
      ),
    ).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  it('stops at the end date when there is one', () => {
    expect(
      datesToGenerate(contract({ endsOn: '2026-07-29' }), '2026-08-10'),
    ).toEqual(['2026-07-27', '2026-07-28', '2026-07-29']);
  });

  it('books nothing once the contract has ended', () => {
    expect(
      datesToGenerate(
        contract({ endsOn: '2026-07-28', generatedThroughOn: '2026-07-28' }),
        '2026-08-10',
      ),
    ).toEqual([]);
  });

  it('is open-ended when there is no end date', () => {
    // The normal case. A contract with no end goes on booking forever, which
    // is what a standing arrangement is.
    const dates = datesToGenerate(contract(), '2027-01-01');
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]).toBe('2026-07-27');
  });

  it('will not try to backfill years in one run', () => {
    // A contract that started long ago and has never generated must not
    // attempt seven hundred jobs in a single cron invocation.
    const dates = datesToGenerate(
      contract({ startsOn: '2020-01-01' }),
      '2026-07-31',
    );
    expect(dates.length).toBeLessThanOrEqual(MAX_GENERATE_AHEAD_DAYS * 2);
  });

  it('counts calendar days across a clocks change', () => {
    // The clocks go back on 25 October 2026. Every date in the range has to
    // appear exactly once — a duplicate books two cars, a gap books none.
    const dates = datesToGenerate(
      contract({ startsOn: '2026-10-23' }),
      '2026-10-27',
    );
    expect(dates).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(new Set(dates).size).toBe(dates.length);
  });
});

describe('runsOn', () => {
  it('treats an empty list as every day', () => {
    // Including weekends, which is what the form says it means.
    expect(runsOn([], '2026-08-01')).toBe(true); // a Saturday
    expect(runsOn([], '2026-08-02')).toBe(true); // a Sunday
  });

  it('matches Sunday as zero', () => {
    expect(weekdayOf('2026-08-02')).toBe(0);
    expect(runsOn([0], '2026-08-02')).toBe(true);
    expect(runsOn([1], '2026-08-02')).toBe(false);
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
  });

  it('crosses a clocks change without losing a day', () => {
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
  });
});

describe('describeWeekdays', () => {
  it('names the common shapes', () => {
    expect(describeWeekdays([])).toBe('Every day');
    expect(describeWeekdays([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(describeWeekdays([0, 6])).toBe('Weekends');
    expect(describeWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
  });

  it('reads Monday first, whatever order they were ticked', () => {
    expect(describeWeekdays([5, 1])).toBe('Mon, Fri');
  });
});

describe('contractSchema', () => {
  const valid = {
    label: 'Aldridge school run',
    accountId: 'acc-1',
    pickupText: '21 York Terrace East',
    dropoffText: 'Highgate School',
    startTime: '07:45',
    startsOn: '2026-09-01',
    dayRatePence: '120.00',
    driverDayRatePence: '55.00',
    weekdays: [1, 2, 3, 4, 5],
  };

  it('accepts a contract with no end date', () => {
    // The whole point of the correction: most of these run until somebody
    // stops them, and requiring an end would make them unrecordable.
    const parsed = contractSchema.parse(valid);
    expect(parsed.endsOn).toBeNull();
  });

  it('refuses a contract with no day rate', () => {
    // It would create a job a day, forever, each worth nothing.
    const result = contractSchema.safeParse({ ...valid, dayRatePence: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/bills nothing, every day/);
    }
  });

  it('refuses a contract billable to nobody', () => {
    const result = contractSchema.safeParse({
      ...valid,
      accountId: '',
      clientId: '',
    });
    expect(result.success).toBe(false);
  });

  it('refuses an end before the start', () => {
    expect(
      contractSchema.safeParse({ ...valid, endsOn: '2026-08-01' }).success,
    ).toBe(false);
  });

  it('keeps the pickup time as a wall clock, not an instant', () => {
    // A repeating time of day. Held as an instant it would drift by an hour
    // in October and put a driver at the school gates at 06:45.
    expect(contractSchema.parse(valid).startTime).toBe('07:45');
  });
});
