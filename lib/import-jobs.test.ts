import { describe, expect, it } from 'vitest';
import { dryRun } from './import';
import { parseMoneyPence, validateJobRow } from './import-rows';

/**
 * The historical job file, and the two rules it is allowed to bend.
 *
 * `importJobs` writes a job straight into a terminal status, which nothing
 * else in the product may do. That is safe only while the reasons hold, so
 * the reasons are pinned here rather than left in a comment: a completed job
 * still cannot arrive unpriced and unexplained, and a job still cannot arrive
 * in a status that would put last year's work into today's dispatch queue.
 */

const HEADERS =
  'date,time,job_type,status,pickup,dropoff,client_name,account_name,driver_phone,driver_name,vehicle_registration,client_price,driver_price,zero_value_reason,passenger_name,passenger_phone,legacy_reference,notes';

/** One row, with only the columns a test cares about set. */
function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    date: '2026-03-14',
    time: '14:30',
    jobtype: 'TRANSFER',
    status: 'COMPLETED',
    pickup: 'The Savoy, Strand',
    dropoff: 'Heathrow T5',
    clientname: 'Mr Yinka',
    accountname: 'Montclares',
    driverphone: '07700 900123',
    drivername: 'Sam Okafor',
    vehicleregistration: 'AB12 CDE',
    clientprice: '165.50',
    driverprice: '105.00',
    zerovaluereason: '',
    passengername: '',
    passengerphone: '',
    legacyreference: 'WL 0562',
    notes: '',
    ...overrides,
  };
}

const csv = (...lines: string[]) => [HEADERS, ...lines].join('\n');

describe('parseMoneyPence', () => {
  it('reads pounds as pence without touching a float', () => {
    // 165.50 * 100 is 16549.999... in binary floating point. Any implementation
    // that multiplies will eventually be a penny out on somebody's invoice.
    expect(parseMoneyPence('165.50')).toEqual({ ok: true, value: 16550 });
    expect(parseMoneyPence('£1,234.05')).toEqual({ ok: true, value: 123405 });
    expect(parseMoneyPence('90')).toEqual({ ok: true, value: 9000 });
    expect(parseMoneyPence('0.07')).toEqual({ ok: true, value: 7 });
  });

  it('treats an empty cell as no price, not as zero', () => {
    // The difference the whole product turns on: nobody wrote a price down,
    // which is not the same as the job being free.
    expect(parseMoneyPence('   ')).toEqual({ ok: true, value: null });
  });

  it('refuses what is not an amount', () => {
    expect(parseMoneyPence('£32/h').ok).toBe(false);
    expect(parseMoneyPence('-40').ok).toBe(false);
    expect(parseMoneyPence('1.234').ok).toBe(false);
  });
});

describe('validateJobRow', () => {
  it('accepts a complete row', () => {
    const outcome = validateJobRow(row(), 2);
    expect(outcome.errors).toEqual([]);
    expect(outcome.value?.clientPricePence).toBe(16550);
    expect(outcome.value?.driverPricePence).toBe(10500);
    expect(outcome.value?.legacyReference).toBe('WL 0562');
  });

  it('refuses to complete a job with no price and no reason', () => {
    // The defect this system exists to fix: 140 of 141 legacy jobs were worth
    // £0 because nothing ever asked. An import is not an exemption.
    const outcome = validateJobRow(row({ clientprice: '' }), 2);
    expect(outcome.value).toBeNull();
    expect(outcome.errors[0]?.message).toMatch(/zero_value_reason/);
  });

  it('completes an unpriced job when the reason is stated', () => {
    const outcome = validateJobRow(
      row({ clientprice: '', zerovaluereason: 'No client price recorded' }),
      2,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.value?.clientPricePence).toBeNull();
    expect(outcome.value?.zeroValueReason).toBe('No client price recorded');
  });

  it('lets an unpriced job that was cancelled through untouched', () => {
    // Nothing was earned and nothing needs explaining.
    const outcome = validateJobRow(row({ status: 'CANCELLED', clientprice: '' }), 2);
    expect(outcome.errors).toEqual([]);
    expect(outcome.value?.status).toBe('CANCELLED');
  });

  it('refuses a status that would put old work into today’s queue', () => {
    const outcome = validateJobRow(row({ status: 'PENDING' }), 2);
    expect(outcome.value).toBeNull();
    expect(outcome.errors[0]?.column).toBe('status');
  });

  it('reads the clock in UK local time, through the summer change', () => {
    // 14:30 in March is GMT; 14:30 in July is BST and an hour earlier in UTC.
    // Storing both as 14:30Z would show every summer pickup an hour late.
    const winter = validateJobRow(row({ date: '2026-01-14' }), 2);
    const summer = validateJobRow(row({ date: '2026-07-14' }), 3);
    expect(winter.value?.scheduledAt.toISOString()).toBe('2026-01-14T14:30:00.000Z');
    expect(summer.value?.scheduledAt.toISOString()).toBe('2026-07-14T13:30:00.000Z');
  });

  it('puts a job with no time at midday, and says so', () => {
    // Midnight would render as the previous evening in local time and move
    // the job to the day before.
    const outcome = validateJobRow(row({ time: '' }), 2);
    expect(outcome.value?.timeAssumed).toBe(true);
    expect(outcome.value?.scheduledAt.toISOString()).toBe('2026-03-14T12:00:00.000Z');
  });

  it('needs a date, a pickup and a drop-off', () => {
    expect(validateJobRow(row({ date: '' }), 2).value).toBeNull();
    expect(validateJobRow(row({ pickup: '' }), 2).value).toBeNull();
    expect(validateJobRow(row({ dropoff: '' }), 2).value).toBeNull();
  });

  it('identifies a job by what it was, not by its old number', () => {
    // The legacy sheets restarted their numbering, so "WL 0562" names three
    // different jobs. Two rows with the same old reference are two jobs.
    const a = validateJobRow(row({ legacyreference: 'WL 0562' }), 2);
    const b = validateJobRow(
      row({ legacyreference: 'WL 0562', pickup: 'Claridge’s' }),
      3,
    );
    expect(a.value?.matchKey).not.toBe(b.value?.matchKey);

    // …and the same run written twice is one job, whatever it was called.
    const c = validateJobRow(row({ legacyreference: 'ALL-0562' }), 4);
    expect(a.value?.matchKey).toBe(c.value?.matchKey);
  });
});

describe('dryRun over a jobs file', () => {
  it('reports every problem in one pass and writes nothing', () => {
    const summary = dryRun(
      'jobs',
      csv(
        '2026-03-14,14:30,TRANSFER,COMPLETED,Savoy,Heathrow,,,,,,165.50,,,,,WL 1,',
        '2026-03-15,,TRANSFER,COMPLETED,Savoy,Gatwick,,,,,,,,,,,WL 2,',
        'not-a-date,,TRANSFER,COMPLETED,Savoy,Luton,,,,,,90,,,,,WL 3,',
      ),
    );

    expect(summary.totalRows).toBe(3);
    expect(summary.created).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.errors.map((e) => e.column)).toEqual(
      expect.arrayContaining(['client_price', 'date']),
    );
  });

  it('counts a repeated run once', () => {
    const line = '2026-03-14,14:30,TRANSFER,COMPLETED,Savoy,Heathrow,,,07700 900123,,,90,,,,,WL 1,';
    const summary = dryRun('jobs', csv(line, line));
    expect(summary.skipped).toBe(1);
    expect(summary.errors.some((e) => /same record/i.test(e.message))).toBe(true);
  });
});

describe('two jobs in one day', () => {
  it('keeps a morning and an afternoon run apart', () => {
    // An as-directed client taking the same car from the same address twice
    // in a day is two jobs. A key that stopped at the date would file the
    // second as a repeat of the first and lose it.
    const morning = validateJobRow(row({ time: '07:00' }), 2);
    const afternoon = validateJobRow(row({ time: '15:00' }), 3);
    expect(morning.value?.matchKey).not.toBe(afternoon.value?.matchKey);
  });

  it('still treats the same run written twice as one job', () => {
    const a = validateJobRow(row({ legacyreference: 'WL 0597' }), 2);
    const b = validateJobRow(row({ legacyreference: 'WL 0001' }), 3);
    expect(a.value?.matchKey).toBe(b.value?.matchKey);
  });
});
