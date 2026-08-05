import { describe, expect, it } from 'vitest';
import {
  canCloseShift,
  canOpenShift,
  formatShiftLength,
  isOpen,
  paidMinutes,
  paidMinutesTo,
  shiftPayPence,
  shiftProfit,
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
