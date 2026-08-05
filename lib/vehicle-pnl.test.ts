import { describe, expect, it } from 'vitest';
import {
  defaultPnlWindow,
  parsePnlWindow,
  rankByProfit,
  vehiclePnl,
  windowToInputs,
  type VehiclePnlInput,
} from './vehicle-pnl';

/**
 * Per-vehicle profit is the number that decides whether a car is worth
 * keeping, so the cases that must not be got wrong are pinned: a driver's own
 * car never carrying company costs, rental revenue staying visible, and a
 * financed car parked all month still costing money.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function input(overrides: Partial<VehiclePnlInput> = {}): VehiclePnlInput {
  return {
    ownership: 'FINANCED',
    jobs: [],
    rentalRevenuePence: 0,
    shiftPayPence: 0,
    oneOffCostPence: 0,
    standingCosts: [],
    from: d('2026-06-01'),
    to: d('2026-06-30'),
    ...overrides,
  };
}

describe('a company car', () => {
  it('nets running costs and driver pay off what it earned', () => {
    const pnl = vehiclePnl(
      input({
        jobs: [
          { revenuePence: 40000, driverPayPence: 24000, companyExpensePence: 1500 },
          { revenuePence: 30000, driverPayPence: 18000, companyExpensePence: 0 },
        ],
        oneOffCostPence: 12000,
      }),
    );

    expect(pnl.jobRevenuePence).toBe(70000);
    expect(pnl.driverPayPence).toBe(42000);
    expect(pnl.companyExpensePence).toBe(1500);
    expect(pnl.runningCostPence).toBe(12000);
    expect(pnl.profitPence).toBe(70000 - 42000 - 1500 - 12000);
  });

  it('keeps rental revenue as its own line', () => {
    // A car earning from hire and badly from jobs is a different decision
    // from one earning evenly. A blended figure hides which is which.
    const pnl = vehiclePnl(
      input({
        jobs: [{ revenuePence: 20000, driverPayPence: 12000, companyExpensePence: 0 }],
        rentalRevenuePence: 56000,
      }),
    );
    expect(pnl.jobRevenuePence).toBe(20000);
    expect(pnl.rentalRevenuePence).toBe(56000);
    expect(pnl.revenuePence).toBe(76000);
  });

  it('accrues standing costs across the window', () => {
    const pnl = vehiclePnl(
      input({
        standingCosts: [
          {
            amountPence: 120000,
            periodMonths: 12,
            startsOn: d('2026-01-01'),
            endsOn: null,
          },
        ],
      }),
    );
    // About a month of a £1,200 annual premium.
    expect(pnl.standingCostPence).toBeGreaterThan(9000);
    expect(pnl.standingCostPence).toBeLessThan(11000);
  });

  it('shows a car that sat idle all month as still costing money', () => {
    // The finance payment does not stop because nobody drove it. This is
    // exactly the case the profit view exists to surface.
    const pnl = vehiclePnl(
      input({
        standingCosts: [
          { amountPence: 45000, periodMonths: 1, startsOn: d('2026-01-01'), endsOn: null },
        ],
      }),
    );
    expect(pnl.revenuePence).toBe(0);
    expect(pnl.profitPence).toBeLessThan(0);
    expect(pnl.idle).toBe(false);
  });

  it('counts shift pay as a cost of the car', () => {
    const pnl = vehiclePnl(
      input({
        jobs: [{ revenuePence: 40000, driverPayPence: 0, companyExpensePence: 0 }],
        shiftPayPence: 15300,
      }),
    );
    expect(pnl.driverPayPence).toBe(15300);
    expect(pnl.profitPence).toBe(40000 - 15300);
  });
});

describe('a driver-owned car', () => {
  const owned = {
    ownership: 'DRIVER_OWNED' as const,
    jobs: [{ revenuePence: 40000, driverPayPence: 26000, companyExpensePence: 0 }],
  };

  it('shows the company’s margin', () => {
    const pnl = vehiclePnl(input(owned));
    expect(pnl.revenuePence).toBe(40000);
    expect(pnl.driverPayPence).toBe(26000);
    expect(pnl.profitPence).toBe(14000);
  });

  it('never counts running costs, even if some were recorded', () => {
    // Counting them would be wrong twice: understating this car's margin and
    // overstating what the company spends.
    const pnl = vehiclePnl(
      input({
        ...owned,
        oneOffCostPence: 50000,
        standingCosts: [
          { amountPence: 120000, periodMonths: 12, startsOn: d('2026-01-01'), endsOn: null },
        ],
      }),
    );
    expect(pnl.runningCostPence).toBe(0);
    expect(pnl.standingCostPence).toBe(0);
    expect(pnl.profitPence).toBe(14000);
    expect(pnl.costsCounted).toBe(false);
  });

  it('still counts a job expense the company bore', () => {
    // Whose car it is does not change who paid the congestion charge.
    const pnl = vehiclePnl(
      input({
        ownership: 'DRIVER_OWNED',
        jobs: [
          { revenuePence: 40000, driverPayPence: 26000, companyExpensePence: 1500 },
        ],
      }),
    );
    expect(pnl.companyExpensePence).toBe(1500);
    expect(pnl.profitPence).toBe(12500);
  });
});

describe('edges', () => {
  it('reports a car with nothing at all as idle', () => {
    const pnl = vehiclePnl(input());
    expect(pnl.idle).toBe(true);
    // No revenue means no margin, not a margin of zero.
    expect(pnl.marginPct).toBeNull();
  });

  it('reports a negative margin on a loss', () => {
    const pnl = vehiclePnl(
      input({
        jobs: [{ revenuePence: 10000, driverPayPence: 8000, companyExpensePence: 0 }],
        oneOffCostPence: 20000,
      }),
    );
    expect(pnl.profitPence).toBe(-18000);
    expect(pnl.marginPct).toBeLessThan(0);
  });
});

describe('rankByProfit', () => {
  const make = (profit: number, idle = false) => ({
    pnl: { ...vehiclePnl(input()), profitPence: profit, idle },
  });

  it('puts the biggest loss first', () => {
    const ranked = rankByProfit([make(5000), make(-20000), make(1000)]);
    expect(ranked.map((v) => v.pnl.profitPence)).toEqual([-20000, 1000, 5000]);
  });

  it('sorts idle cars last whatever their profit', () => {
    // A car that did nothing is not the fleet's problem; a string of zeroes
    // at the top buries the one that actually lost money.
    const ranked = rankByProfit([make(0, true), make(-5000), make(2000)]);
    expect(ranked[0]?.pnl.profitPence).toBe(-5000);
    expect(ranked[2]?.pnl.idle).toBe(true);
  });
});

describe('defaultPnlWindow', () => {
  it('covers the last twelve months', () => {
    const { from, to } = defaultPnlWindow(new Date('2026-08-05T12:00:00Z'));
    expect(from.getFullYear()).toBe(2025);
    expect(to.getFullYear()).toBe(2026);
    expect(to.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('parsePnlWindow', () => {
  const now = new Date('2026-08-05T12:00:00Z');

  it('covers the whole of both end days', () => {
    // A window typed as a single date has to include the jobs done on it,
    // not only the ones at midnight.
    const { from, to } = parsePnlWindow('2026-06-15', '2026-06-15', now);
    expect(from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-15T23:59:59.999Z');
  });

  it('falls back to the last twelve months', () => {
    const fallback = defaultPnlWindow(now);
    const { from, to } = parsePnlWindow(null, undefined, now);
    expect(from.getTime()).toBe(fallback.from.getTime());
    expect(to.getTime()).toBe(fallback.to.getTime());
  });

  it('ignores anything that is not a date', () => {
    const fallback = defaultPnlWindow(now);
    const { from } = parsePnlWindow('last tuesday', '', now);
    expect(from.getTime()).toBe(fallback.from.getTime());
  });

  it('turns a backwards window the right way round', () => {
    // Reported as-is it would show zero of everything, which reads as an idle
    // car rather than as a typo.
    const { from, to } = parsePnlWindow('2026-07-01', '2026-06-01', now);
    expect(from.getTime()).toBeLessThan(to.getTime());
    expect(from.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('round-trips through the date inputs', () => {
    const parsed = parsePnlWindow('2026-01-31', '2026-02-28', now);
    expect(windowToInputs(parsed)).toEqual({
      from: '2026-01-31',
      to: '2026-02-28',
    });
  });
});
