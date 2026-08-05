import { describe, expect, it } from 'vitest';
import {
  billableWaitMinutes,
  billedHours,
  calculateFinance,
  DEFAULT_FREE_WAIT_MINUTES,
  financeSchema,
  freeWaitMinutesFor,
  hourlyCharge,
  jobEconomics,
  prefillFromBooking,
  toFinanceData,
} from './job-finance';

/**
 * These totals end up on invoices and driver statements, so the arithmetic is
 * pinned rather than assumed. The rounding cases matter most: they are where
 * a penny goes missing and two documents stop reconciling.
 */

describe('calculateFinance', () => {
  it('adds the fixed revenue components', () => {
    const totals = calculateFinance({
      baseFarePence: 12550,
      waitTimePence: 500,
      extraChargesPence: 1000,
    });
    expect(totals.totalClientPence).toBe(14050);
  });

  it('adds hourly revenue on top of the base fare', () => {
    // An as-directed job with a standing charge plus 3.5 hours at £45.
    const totals = calculateFinance({
      baseFarePence: 5000,
      customerHours: 3.5,
      customerRatePence: 4500,
    });
    expect(totals.totalClientPence).toBe(5000 + 15750);
  });

  it('computes gross profit as revenue minus cost', () => {
    const totals = calculateFinance({
      baseFarePence: 20000,
      driverPaymentPence: 12000,
      fuelCostPence: 1500,
    });
    expect(totals.totalCostsPence).toBe(13500);
    expect(totals.grossProfitPence).toBe(6500);
  });

  it('reports a negative gross profit rather than clamping it', () => {
    // A job that cost more than it earned is a fact the operator needs.
    const totals = calculateFinance({
      baseFarePence: 5000,
      driverPaymentPence: 8000,
    });
    expect(totals.grossProfitPence).toBe(-3000);
    expect(totals.marginPct).toBe(-60);
  });

  it('returns a null margin on zero revenue, not 0%', () => {
    // 0% reads like a priced job that broke even. Null is "no price yet",
    // which is the whole problem being solved.
    const totals = calculateFinance({ driverPaymentPence: 8000 });
    expect(totals.totalClientPence).toBe(0);
    expect(totals.marginPct).toBeNull();
  });

  it('treats null and undefined inputs as zero', () => {
    const totals = calculateFinance({
      baseFarePence: 10000,
      waitTimePence: null,
      extraChargesPence: undefined,
      customerHours: null,
      customerRatePence: null,
    });
    expect(totals.totalClientPence).toBe(10000);
  });

  it('is a no-op on an entirely empty job', () => {
    expect(calculateFinance({})).toEqual({
      totalClientPence: 0,
      totalCostsPence: 0,
      grossProfitPence: 0,
      marginPct: null,
    });
  });

  it('computes margin to two decimal places', () => {
    const totals = calculateFinance({
      baseFarePence: 30000,
      driverPaymentPence: 20000,
    });
    expect(totals.grossProfitPence).toBe(10000);
    expect(totals.marginPct).toBeCloseTo(33.33, 2);
  });
});

describe('hourlyCharge rounding', () => {
  it('rounds half away from zero, once', () => {
    // 2.5 hours at £10.01 is 2502.5p. Rounding half up and half away agree
    // here; the point is that it is rounded at all rather than stored as a
    // fraction of a penny.
    expect(hourlyCharge(2.5, 1001)).toBe(2503);
  });

  it('rounds each hourly line separately, so totals match their own lines', () => {
    // If rounding happened after summing, the total could differ by a penny
    // from adding up the two rounded figures an invoice would display.
    const customer = hourlyCharge(1.5, 3333);
    const driver = hourlyCharge(1.5, 2222);
    const totals = calculateFinance({
      customerHours: 1.5,
      customerRatePence: 3333,
      driverHours: 1.5,
      driverRatePence: 2222,
    });
    expect(totals.totalClientPence).toBe(customer);
    expect(totals.totalCostsPence).toBe(driver);
  });

  it('is zero when either side is missing', () => {
    expect(hourlyCharge(null, 4500)).toBe(0);
    expect(hourlyCharge(3, null)).toBe(0);
    expect(hourlyCharge(0, 4500)).toBe(0);
  });

  it('handles a fractional hour that lands on an exact penny', () => {
    expect(hourlyCharge(0.25, 4000)).toBe(1000);
  });
});

describe('prefillFromBooking', () => {
  it('seeds the panel from the prices agreed at booking', () => {
    // Retyping is where the booking price and the invoice drift apart.
    expect(
      prefillFromBooking({ clientPricePence: 12550, driverPricePence: 8000 }),
    ).toEqual({ baseFarePence: 12550, driverPaymentPence: 8000 });
  });

  it('seeds zero when the job was never priced', () => {
    expect(
      prefillFromBooking({ clientPricePence: null, driverPricePence: null }),
    ).toEqual({ baseFarePence: 0, driverPaymentPence: 0 });
  });
});

describe('financeSchema', () => {
  const valid = {
    baseFarePence: 12550,
    waitTimePence: 0,
    waitMinutesBilled: 0,
    extraChargesPence: 0,
    customerHours: '',
    customerRatePence: 0,
    driverPaymentPence: 8000,
    fuelCostPence: 0,
    otherExpensesPence: 0,
    driverHours: '',
    driverRatePence: 0,
    driverPayStatus: 'UNPAID' as const,
  };

  it('accepts a minimal panel submission', () => {
    expect(financeSchema.parse(valid).baseFarePence).toBe(12550);
  });

  it('turns blank hours into null rather than zero', () => {
    // Null means "not an hourly job". Zero would claim it ran for no time.
    expect(financeSchema.parse(valid).customerHours).toBeNull();
  });

  it('rejects a negative amount', () => {
    expect(() =>
      financeSchema.parse({ ...valid, baseFarePence: -1 }),
    ).toThrow();
  });

  it('rejects fractional pence', () => {
    // Money is integer pence everywhere. A float here is a bug upstream.
    expect(() => financeSchema.parse({ ...valid, baseFarePence: 125.5 })).toThrow();
  });

  it('rejects negative hours', () => {
    expect(() => financeSchema.parse({ ...valid, customerHours: -1 })).toThrow();
  });
});

describe('toFinanceData', () => {
  const base = {
    baseFarePence: 20000,
    waitTimePence: 0,
    waitMinutesBilled: 0,
    extraChargesPence: 0,
    customerHours: null,
    customerRatePence: 0,
    driverPaymentPence: 12000,
    fuelCostPence: 0,
    otherExpensesPence: 0,
    driverHours: null,
    driverRatePence: 0,
    driverPayStatus: 'UNPAID' as const,
  };

  it('recomputes the totals rather than taking them from the caller', () => {
    const data = toFinanceData(base);
    expect(data.totalClientPence).toBe(20000);
    expect(data.totalCostsPence).toBe(12000);
    expect(data.grossProfitPence).toBe(8000);
  });

  it('normalises blank notes to null', () => {
    const data = toFinanceData({ ...base, expenseNotes: '   ' });
    expect(data.expenseNotes).toBeNull();
  });

  it('normalises a blank pay method to null rather than an empty string', () => {
    // The column is a nullable enum; '' is not a member of it.
    expect(toFinanceData({ ...base, driverPayMethod: '' }).driverPayMethod).toBeNull();
  });

  it('keeps a real pay method and paid date', () => {
    const data = toFinanceData({
      ...base,
      driverPayStatus: 'FULLY_PAID',
      driverPayMethod: 'BANK_TRANSFER',
      driverPaidAt: '2026-08-04',
    });
    expect(data.driverPayMethod).toBe('BANK_TRANSFER');
    expect(data.driverPaidAt?.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });
});

describe('waiting time', () => {
  it('uses the documented default allowances', () => {
    expect(DEFAULT_FREE_WAIT_MINUTES).toEqual({ airport: 45, other: 15 });
  });

  it('gives airport arrivals the longer allowance', () => {
    // Immigration and baggage are not the passenger's fault.
    expect(freeWaitMinutesFor('AIRPORT_TRANSFER')).toBe(45);
    expect(freeWaitMinutesFor('TRANSFER')).toBe(15);
    expect(freeWaitMinutesFor('AS_DIRECTED')).toBe(15);
  });

  it('respects configured overrides', () => {
    // The allowance is a setting, not a constant.
    expect(freeWaitMinutesFor('AIRPORT_TRANSFER', { airport: 60 })).toBe(60);
    expect(freeWaitMinutesFor('TRANSFER', { other: 20 })).toBe(20);
  });

  it('bills only the minutes beyond the allowance', () => {
    expect(billableWaitMinutes(70, 45)).toBe(25);
  });

  it('bills nothing inside the allowance', () => {
    expect(billableWaitMinutes(30, 45)).toBe(0);
    expect(billableWaitMinutes(45, 45)).toBe(0);
  });

  it('never bills negative time', () => {
    expect(billableWaitMinutes(-5, 15)).toBe(0);
    expect(billableWaitMinutes(0, 15)).toBe(0);
  });

  it('rounds part-minutes down, in the passenger’s favour', () => {
    expect(billableWaitMinutes(60.9, 45)).toBe(15);
  });
});

describe('jobEconomics', () => {
  const finance = { baseFarePence: 20000, driverPaymentPence: 12000 };

  it('adds stop charges to revenue', () => {
    // Revenue the Phase 2 panel never saw.
    const result = jobEconomics({
      finance,
      stops: [{ chargePence: 1500 }, { chargePence: 1000 }],
    });
    expect(result.stopChargePence).toBe(2500);
    expect(result.totalClientPence).toBe(22500);
  });

  it('ignores stops with no charge', () => {
    const result = jobEconomics({
      finance,
      stops: [{ chargePence: null }, { chargePence: 1000 }],
    });
    expect(result.stopChargePence).toBe(1000);
  });

  it('splits expenses three ways by who bears them', () => {
    const result = jobEconomics({
      finance,
      expenses: [
        { amountPence: 1500, borneBy: 'CLIENT' },
        { amountPence: 4000, borneBy: 'COMPANY' },
        { amountPence: 900, borneBy: 'DRIVER' },
      ],
    });
    // Recharged is revenue.
    expect(result.totalClientPence).toBe(21500);
    // Company-borne is cost.
    expect(result.totalCostsPence).toBe(16000);
    // Driver-borne is neither — counting it would understate profit on every
    // owner-driver job.
    expect(result.driverBorneExpensePence).toBe(900);
    expect(result.grossProfitPence).toBe(5500);
  });

  it('drops the per-job driver payment when a shift covers it', () => {
    // Leaving it in would double-count the driver, or leave a stale per-job
    // fee on a job nobody was paid per-job for.
    const result = jobEconomics({ finance, paidByShift: true });
    expect(result.totalCostsPence).toBe(0);
    expect(result.grossProfitPence).toBe(20000);
    expect(result.paidByShift).toBe(true);
  });

  it('keeps company expenses on a shift-paid job', () => {
    // The fuel was still bought; only the driver's time moved to the shift.
    const result = jobEconomics({
      finance,
      paidByShift: true,
      expenses: [{ amountPence: 4000, borneBy: 'COMPANY' }],
    });
    expect(result.totalCostsPence).toBe(4000);
  });

  it('falls back to the booking prices when there is no finance record', () => {
    // A job priced on the phone and never opened in the panel still reports
    // honestly.
    const result = jobEconomics({
      finance: null,
      clientPricePence: 12550,
      driverPricePence: 8000,
    });
    expect(result.totalClientPence).toBe(12550);
    expect(result.totalCostsPence).toBe(8000);
  });

  it('reports nothing for an unpriced job with no finance record', () => {
    const result = jobEconomics({
      finance: null,
      clientPricePence: null,
      driverPricePence: null,
    });
    expect(result.totalClientPence).toBe(0);
    expect(result.marginPct).toBeNull();
  });

  it('combines stops, expenses and hourly revenue', () => {
    const result = jobEconomics({
      finance: {
        baseFarePence: 5000,
        customerHours: 4,
        customerRatePence: 4500,
        driverPaymentPence: 10000,
      },
      stops: [{ chargePence: 1000 }],
      expenses: [{ amountPence: 1500, borneBy: 'CLIENT' }],
    });
    // 5000 base + 18000 hourly + 1000 stop + 1500 recharged.
    expect(result.totalClientPence).toBe(25500);
    expect(result.totalCostsPence).toBe(10000);
  });
});

describe('billedHours', () => {
  it('applies the minimum-hours rule', () => {
    // A two-hour booking on a four-hour minimum bills four.
    expect(billedHours(2, 4)).toBe(4);
  });

  it('bills the actual hours when they exceed the minimum', () => {
    expect(billedHours(6, 4)).toBe(6);
  });

  it('bills the booked hours when there is no minimum', () => {
    expect(billedHours(2, null)).toBe(2);
  });

  it('is null when no hours were booked — not an hourly job', () => {
    expect(billedHours(null, 4)).toBeNull();
  });
});
