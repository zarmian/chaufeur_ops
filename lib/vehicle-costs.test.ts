import { describe, expect, it } from 'vitest';
import {
  accruedStandingCost,
  accrueAll,
  companyBearsCosts,
  COST_KIND_LABELS,
  DEFAULT_SERVICE_MILES,
  OWNERSHIP_LABELS,
  serviceStatus,
  type StandingCost,
} from './vehicle-costs';

/**
 * The pro-rata accrual decides whether a car looks profitable, so it is
 * pinned tightly. The case that matters is the annual premium: charged whole
 * it makes one month a disaster and eleven months free, which tells nobody
 * anything.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function annualInsurance(overrides: Partial<StandingCost> = {}): StandingCost {
  return {
    amountPence: 120000,
    periodMonths: 12,
    startsOn: d('2026-04-01'),
    endsOn: d('2027-03-31'),
    ...overrides,
  };
}

describe('accruedStandingCost', () => {
  it('spreads an annual premium across a month', () => {
    // £1,200 a year is about £100 a month, not £1,200 in April.
    const june = accruedStandingCost(
      annualInsurance(),
      d('2026-06-01'),
      d('2026-06-30'),
    );
    expect(june).toBeGreaterThan(9500);
    expect(june).toBeLessThan(10500);
  });

  it('charges the same in the month the premium is actually paid', () => {
    const april = accruedStandingCost(
      annualInsurance(),
      d('2026-04-01'),
      d('2026-04-30'),
    );
    const june = accruedStandingCost(
      annualInsurance(),
      d('2026-06-01'),
      d('2026-06-30'),
    );
    // Same length months, so within a penny or two of each other.
    expect(Math.abs(april - june)).toBeLessThan(200);
  });

  it('accrues roughly the whole premium across its own year', () => {
    const year = accruedStandingCost(
      annualInsurance(),
      d('2026-04-01'),
      d('2027-03-31'),
    );
    expect(year).toBeGreaterThan(119000);
    expect(year).toBeLessThan(121000);
  });

  it('accrues months that add up to the year', () => {
    // Whole-period charging would double-count anything straddling a
    // boundary, and no two adjacent months would reconcile.
    const cost = annualInsurance();
    let total = 0;
    for (let month = 0; month < 12; month += 1) {
      const from = new Date(Date.UTC(2026, 3 + month, 1));
      const to = new Date(Date.UTC(2026, 4 + month, 0));
      total += accruedStandingCost(cost, from, to);
    }
    expect(total).toBeGreaterThan(119000);
    expect(total).toBeLessThan(121000);
  });

  it('charges nothing before it starts or after it ends', () => {
    expect(
      accruedStandingCost(annualInsurance(), d('2026-01-01'), d('2026-03-31')),
    ).toBe(0);
    expect(
      accruedStandingCost(annualInsurance(), d('2027-05-01'), d('2027-05-31')),
    ).toBe(0);
  });

  it('charges only the overlapping part of a window that straddles the start', () => {
    // March and April, of which only April is covered.
    const straddle = accruedStandingCost(
      annualInsurance(),
      d('2026-03-01'),
      d('2026-04-30'),
    );
    const aprilOnly = accruedStandingCost(
      annualInsurance(),
      d('2026-04-01'),
      d('2026-04-30'),
    );
    expect(straddle).toBe(aprilOnly);
  });

  it('keeps accruing an open-ended cost', () => {
    const finance: StandingCost = {
      amountPence: 45000,
      periodMonths: 1,
      startsOn: d('2026-01-01'),
      endsOn: null,
    };
    const month = accruedStandingCost(finance, d('2030-06-01'), d('2030-06-30'));
    expect(month).toBeGreaterThan(43000);
    expect(month).toBeLessThan(47000);
  });

  it('accrues a single day', () => {
    const day = accruedStandingCost(annualInsurance(), d('2026-06-15'), d('2026-06-15'));
    expect(day).toBeGreaterThan(300);
    expect(day).toBeLessThan(340);
  });

  it('is zero for a nonsensical period or a zero amount', () => {
    expect(
      accruedStandingCost(annualInsurance({ periodMonths: 0 }), d('2026-06-01'), d('2026-06-30')),
    ).toBe(0);
    expect(
      accruedStandingCost(annualInsurance({ amountPence: 0 }), d('2026-06-01'), d('2026-06-30')),
    ).toBe(0);
  });

  it('adds several standing costs together', () => {
    const total = accrueAll(
      [
        annualInsurance(),
        { amountPence: 45000, periodMonths: 1, startsOn: d('2026-01-01'), endsOn: null },
      ],
      d('2026-06-01'),
      d('2026-06-30'),
    );
    // About £100 insurance plus about £450 finance.
    expect(total).toBeGreaterThan(53000);
    expect(total).toBeLessThan(57000);
  });
});

describe('companyBearsCosts', () => {
  it('is false only for a driver-owned car', () => {
    expect(companyBearsCosts('DRIVER_OWNED')).toBe(false);
    for (const ownership of ['OWNED', 'FINANCED', 'LEASED'] as const) {
      expect(companyBearsCosts(ownership), ownership).toBe(true);
    }
  });
});

describe('serviceStatus', () => {
  const at = d('2026-08-05');

  it('is due when the interval has passed', () => {
    const status = serviceStatus(
      {
        lastServicedOn: d('2025-06-01'),
        lastServiceMiles: null,
        currentOdometer: null,
        serviceEveryMonths: 12,
        serviceEveryMiles: null,
      },
      at,
    );
    expect(status.due).toBe(true);
    expect(status.reason).toMatch(/overdue by \d+ days/);
  });

  it('is not due inside the interval', () => {
    const status = serviceStatus(
      {
        lastServicedOn: d('2026-06-01'),
        lastServiceMiles: null,
        currentOdometer: null,
        serviceEveryMonths: 12,
        serviceEveryMiles: null,
      },
      at,
    );
    expect(status.due).toBe(false);
    expect(status.daysRemaining).toBeGreaterThan(0);
  });

  it('is due on mileage even when the date is not reached', () => {
    // Whichever comes first — a car doing 30,000 miles a year needs servicing
    // long before its anniversary.
    const status = serviceStatus(
      {
        lastServicedOn: d('2026-06-01'),
        lastServiceMiles: 40000,
        currentOdometer: 55000,
        serviceEveryMonths: 12,
        serviceEveryMiles: 12000,
      },
      at,
    );
    expect(status.due).toBe(true);
    expect(status.reason).toMatch(/overdue by 3000 miles/);
  });

  it('reports miles remaining before it is due', () => {
    const status = serviceStatus(
      {
        lastServicedOn: d('2026-06-01'),
        lastServiceMiles: 40000,
        currentOdometer: 45000,
        serviceEveryMonths: 12,
        serviceEveryMiles: 12000,
      },
      at,
    );
    expect(status.due).toBe(false);
    expect(status.milesRemaining).toBe(7000);
  });

  it('says nothing about a car with no service history and no reading', () => {
    // Claiming a service is due on a car nobody has recorded anything about
    // is noise, not information.
    const status = serviceStatus(
      {
        lastServicedOn: null,
        lastServiceMiles: null,
        currentOdometer: null,
        serviceEveryMonths: null,
        serviceEveryMiles: null,
      },
      at,
    );
    expect(status.due).toBe(false);
    expect(status.reason).toBeNull();
  });

  it('falls back to the fleet defaults', () => {
    const status = serviceStatus(
      {
        lastServicedOn: d('2026-06-01'),
        lastServiceMiles: 10000,
        currentOdometer: 10000 + DEFAULT_SERVICE_MILES + 1,
        serviceEveryMonths: null,
        serviceEveryMiles: null,
      },
      at,
    );
    expect(status.due).toBe(true);
  });
});

describe('labels', () => {
  it('names every cost kind and ownership', () => {
    for (const label of Object.values(COST_KIND_LABELS)) expect(label).toBeTruthy();
    for (const label of Object.values(OWNERSHIP_LABELS)) expect(label).toBeTruthy();
  });
});
