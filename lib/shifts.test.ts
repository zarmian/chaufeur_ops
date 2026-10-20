import { describe, expect, it } from 'vitest';
import {
  canCloseShift,
  canOpenShift,
  canRecordShift,
  formatShiftLength,
  isOpen,
  paidMinutes,
  paidMinutesTo,
  shiftPayPence,
  shiftProfit,
  shiftsOverlap,
} from './shifts';

/**
 * Shift pay is what a hired driver actually receives, so the arithmetic is
 * pinned. The break subtraction and the single rounding are the two places a
 * statement and a payout would otherwise drift apart.
 */

const at = (iso: string) => new Date(iso);

describe('paidMinutes', () => {
  it('measures elapsed time less the unpaid break', () => {
    expect(
      paidMinutes({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: at('2026-08-04T17:00:00Z'),
        breakMinutes: 30,
      }),
    ).toBe(510);
  });

  it('returns null for an open shift rather than measuring to now', () => {
    // A figure that changes every time you look at it is not something a
    // driver can be paid on.
    expect(
      paidMinutes({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: null,
        breakMinutes: 0,
      }),
    ).toBeNull();
  });

  it('never goes negative when the break swallows the shift', () => {
    expect(
      paidMinutes({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: at('2026-08-04T08:20:00Z'),
        breakMinutes: 60,
      }),
    ).toBe(0);
  });

  it('ignores a negative break rather than paying extra for it', () => {
    expect(
      paidMinutes({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: at('2026-08-04T09:00:00Z'),
        breakMinutes: -30,
      }),
    ).toBe(60);
  });

  it('gives a running total for an open shift when asked explicitly', () => {
    expect(
      paidMinutesTo(
        { startedAt: at('2026-08-04T08:00:00Z'), endedAt: null, breakMinutes: 0 },
        at('2026-08-04T11:30:00Z'),
      ),
    ).toBe(210);
  });
});

describe('shiftPayPence', () => {
  it('pays hours at the shift rate', () => {
    // 8.5 hours at £18.00.
    expect(
      shiftPayPence({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: at('2026-08-04T17:00:00Z'),
        breakMinutes: 30,
        hourlyRatePence: 1800,
      }),
    ).toBe(15300);
  });

  it('rounds once, at the point minutes become money', () => {
    // 1h 40m at £13.33 is 2221.66p — one rounding, to 2222.
    expect(
      shiftPayPence({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: at('2026-08-04T09:40:00Z'),
        breakMinutes: 0,
        hourlyRatePence: 1333,
      }),
    ).toBe(2222);
  });

  it('is null while the shift is open', () => {
    expect(
      shiftPayPence({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: null,
        breakMinutes: 0,
        hourlyRatePence: 1800,
      }),
    ).toBeNull();
  });

  it('pays nothing for a shift entirely consumed by its break', () => {
    expect(
      shiftPayPence({
        startedAt: at('2026-08-04T08:00:00Z'),
        endedAt: at('2026-08-04T08:15:00Z'),
        breakMinutes: 30,
        hourlyRatePence: 1800,
      }),
    ).toBe(0);
  });
});

describe('opening and closing', () => {
  it('allows a shift when the driver has none open', () => {
    expect(canOpenShift(null)).toEqual({ ok: true });
  });

  it('refuses a second open shift and names the first', () => {
    // Two open shifts make "how long did they work" unanswerable.
    const result = canOpenShift({
      reference: 'SHF-000012',
      startedAt: at('2026-08-04T08:00:00Z'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('SHF-000012');
  });

  it('refuses to close a shift that already ended', () => {
    expect(
      canCloseShift(
        {
          startedAt: at('2026-08-04T08:00:00Z'),
          endedAt: at('2026-08-04T17:00:00Z'),
          breakMinutes: 0,
        },
        at('2026-08-04T18:00:00Z'),
      ).ok,
    ).toBe(false);
  });

  it('refuses an end before the start', () => {
    expect(
      canCloseShift(
        { startedAt: at('2026-08-04T08:00:00Z'), endedAt: null, breakMinutes: 0 },
        at('2026-08-04T07:00:00Z'),
      ).ok,
    ).toBe(false);
  });

  it('refuses a break longer than the shift, and says by how much', () => {
    const result = canCloseShift(
      { startedAt: at('2026-08-04T08:00:00Z'), endedAt: null, breakMinutes: 90 },
      at('2026-08-04T09:00:00Z'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('90');
      expect(result.message).toContain('60');
    }
  });

  it('accepts an ordinary close', () => {
    expect(
      canCloseShift(
        { startedAt: at('2026-08-04T08:00:00Z'), endedAt: null, breakMinutes: 30 },
        at('2026-08-04T17:00:00Z'),
      ),
    ).toEqual({ ok: true });
  });

  it('knows an open shift from a closed one', () => {
    expect(isOpen({ endedAt: null })).toBe(true);
    expect(isOpen({ endedAt: at('2026-08-04T17:00:00Z') })).toBe(false);
  });
});

describe('shiftProfit', () => {
  it('nets shift pay and company expenses off the jobs’ revenue', () => {
    // This is where a hired driver's economics live — per-job gross profit
    // cannot answer it, because the cost was never per-job.
    const profit = shiftProfit(15300, [
      { revenuePence: 20000, companyExpensePence: 1500 },
      { revenuePence: 18000, companyExpensePence: 0 },
    ]);
    expect(profit.revenuePence).toBe(38000);
    expect(profit.payPence).toBe(15300);
    expect(profit.expensePence).toBe(1500);
    expect(profit.grossProfitPence).toBe(21200);
  });

  it('reports a loss on a shift that earned less than it cost', () => {
    // A driver on standby who got one short job is a real and visible loss.
    const profit = shiftProfit(15300, [
      { revenuePence: 4000, companyExpensePence: 0 },
    ]);
    expect(profit.grossProfitPence).toBe(-11300);
    expect(profit.marginPct).toBeLessThan(0);
  });

  it('handles a shift with no jobs at all', () => {
    // Standby is still owed for the hours.
    const profit = shiftProfit(15300, []);
    expect(profit.revenuePence).toBe(0);
    expect(profit.grossProfitPence).toBe(-15300);
    // No revenue means no margin, not a margin of zero.
    expect(profit.marginPct).toBeNull();
  });

  it('treats an open shift as costing nothing yet', () => {
    const profit = shiftProfit(null, [
      { revenuePence: 20000, companyExpensePence: 0 },
    ]);
    expect(profit.payPence).toBe(0);
    expect(profit.grossProfitPence).toBe(20000);
  });
});

describe('formatShiftLength', () => {
  it('reads shifts in hours', () => {
    expect(formatShiftLength(95)).toBe('1h 35m');
    expect(formatShiftLength(120)).toBe('2h');
    expect(formatShiftLength(45)).toBe('45m');
  });

  it('says so when the shift is still running', () => {
    expect(formatShiftLength(null)).toBe('Still open');
  });
});

describe('recording a shift that has already been worked', () => {
  const NOW = new Date('2026-10-20T18:00:00Z');
  const at = (iso: string) => new Date(iso);

  const worked = {
    startedAt: at('2026-10-13T08:00:00Z'),
    endedAt: at('2026-10-13T16:00:00Z'),
    breakMinutes: 30,
  };

  it('accepts a shift worked last week', () => {
    /*
     * The whole point. Until now a shift could only be created at the moment
     * it started, so a day somebody forgot to clock on for could not be
     * entered at all.
     */
    expect(canRecordShift(worked, { now: NOW, clash: null })).toEqual({ ok: true });
  });

  it('does not care that the driver is clocked on right now', () => {
    /*
     * The one-open-shift rule is about whether somebody may clock on. It has
     * nothing to say about work that has already happened — a driver on shift
     * this afternoon may perfectly well have worked last Tuesday — and
     * applying it here would make the feature useless for exactly the drivers
     * who work most.
     */
    const openNow = {
      reference: 'SHF-000001',
      startedAt: at('2026-10-20T06:00:00Z'),
      endedAt: null,
    };

    expect(
      canRecordShift(worked, { now: NOW, clash: null }),
      'last week cannot collide with a shift that opened this morning',
    ).toEqual({ ok: true });
    expect(shiftsOverlap(worked, openNow)).toBe(false);
  });

  it('refuses a shift that has not finished yet', () => {
    // A claim that work is done, made about work that is not.
    const result = canRecordShift(
      { ...worked, endedAt: at('2026-10-21T16:00:00Z') },
      { now: NOW, clash: null },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/has not finished yet/);
  });

  it('refuses a shift that ends before it starts', () => {
    const result = canRecordShift(
      { ...worked, endedAt: at('2026-10-13T07:00:00Z') },
      { now: NOW, clash: null },
    );

    expect(result.ok).toBe(false);
  });

  it('refuses a shift of no length at all', () => {
    // Recording a finished shift of zero minutes is always a mistyped date;
    // unlike closing one, where clocking straight off again is plausible.
    const result = canRecordShift(
      { ...worked, endedAt: worked.startedAt },
      { now: NOW, clash: null },
    );

    expect(result.ok).toBe(false);
  });

  it('catches a mistyped year', () => {
    /*
     * The failure backdating introduces. Entering a shift as it happens is
     * bounded by the clock; entering last Tuesday's is bounded by nothing,
     * and a year typed wrong pays a driver for three hundred and sixty-five
     * days.
     */
    const result = canRecordShift(
      { startedAt: at('2025-10-13T08:00:00Z'), endedAt: at('2026-10-13T16:00:00Z'), breakMinutes: 0 },
      { now: NOW, clash: null },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/Check the dates/);
  });

  it('refuses a break longer than the shift', () => {
    const result = canRecordShift(
      { ...worked, breakMinutes: 9 * 60 },
      { now: NOW, clash: null },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/break is longer/);
  });

  it('refuses a shift that collides with one already recorded', () => {
    /*
     * The check that has to exist before backdating can. The same Tuesday
     * entered twice pays the driver twice, a payout is built from shifts, and
     * nothing downstream would notice.
     */
    const result = canRecordShift(worked, {
      now: NOW,
      clash: {
        reference: 'SHF-000042',
        startedAt: at('2026-10-13T12:00:00Z'),
        endedAt: at('2026-10-13T20:00:00Z'),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/SHF-000042/);
  });
});

describe('shiftsOverlap', () => {
  const span = (from: string, to: string | null) => ({
    startedAt: new Date(from),
    endedAt: to === null ? null : new Date(to),
  });

  it('sees two shifts sharing time', () => {
    expect(
      shiftsOverlap(
        span('2026-10-13T08:00:00Z', '2026-10-13T16:00:00Z'),
        span('2026-10-13T12:00:00Z', '2026-10-13T20:00:00Z'),
      ),
    ).toBe(true);
  });

  it('sees one shift wholly inside another', () => {
    expect(
      shiftsOverlap(
        span('2026-10-13T08:00:00Z', '2026-10-13T20:00:00Z'),
        span('2026-10-13T12:00:00Z', '2026-10-13T14:00:00Z'),
      ),
    ).toBe(true);
  });

  it('lets one end where the next begins', () => {
    // Handing a car over at the top of the hour is the normal case, not a
    // clash.
    expect(
      shiftsOverlap(
        span('2026-10-13T08:00:00Z', '2026-10-13T14:00:00Z'),
        span('2026-10-13T14:00:00Z', '2026-10-13T20:00:00Z'),
      ),
    ).toBe(false);
  });

  it('treats an open shift as running on forever', () => {
    /*
     * Conservative on purpose: those hours are still being counted, so
     * anything starting after it began would be paid twice.
     */
    expect(
      shiftsOverlap(
        span('2026-10-20T06:00:00Z', null),
        span('2026-10-25T09:00:00Z', '2026-10-25T17:00:00Z'),
      ),
    ).toBe(true);

    // But a day that finished before it opened is untouched.
    expect(
      shiftsOverlap(
        span('2026-10-20T06:00:00Z', null),
        span('2026-10-13T09:00:00Z', '2026-10-13T17:00:00Z'),
      ),
    ).toBe(false);
  });

  it('sees nothing between two separate days', () => {
    expect(
      shiftsOverlap(
        span('2026-10-13T08:00:00Z', '2026-10-13T16:00:00Z'),
        span('2026-10-14T08:00:00Z', '2026-10-14T16:00:00Z'),
      ),
    ).toBe(false);
  });
});
