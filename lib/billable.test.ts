import { describe, expect, it } from 'vitest';
import {
  billableItems,
  revenueForPeriod,
  type BillableJob,
  type BillableRental,
} from './billable';

/**
 * What the company can bill, from both sources.
 *
 * Rental income used to reach the per-vehicle profit view and nowhere else,
 * which meant a hire could not be invoiced — somebody chased it by hand, or
 * did not chase it. The cases pinned here are the two that would lose or
 * duplicate money: a hire already part-paid in cash, and one already on an
 * invoice.
 */

const d = (iso: string) => new Date(`${iso}T09:00:00Z`);

function job(overrides: Partial<BillableJob> = {}): BillableJob {
  return {
    id: 'job-1',
    reference: 'JOB-000001',
    occurredAt: d('2026-06-10'),
    totalPence: 40000,
    clientId: 'client-1',
    accountId: null,
    ...overrides,
  };
}

function rental(overrides: Partial<BillableRental> = {}): BillableRental {
  return {
    id: 'rental-1',
    reference: 'RNT-000001',
    occurredAt: d('2026-06-11'),
    totalPence: 56000,
    paidPence: 0,
    driverId: 'driver-1',
    renterName: 'Sam Okafor',
    vehicleRegistration: 'AB12 CDE',
    ...overrides,
  };
}

describe('billableItems', () => {
  it('bills jobs and rentals, keeping the two apart', () => {
    // A blended total hides whether the money came from hire or from work.
    const summary = billableItems({ jobs: [job()], rentals: [rental()] });

    expect(summary.jobPence).toBe(40000);
    expect(summary.rentalPence).toBe(56000);
    expect(summary.totalPence).toBe(96000);
    expect(summary.items).toHaveLength(2);
  });

  it('bills a rental for what is still owed, not its full charge', () => {
    // £400 of a £560 hire already paid in cash leaves £160. Invoicing the
    // full amount would ask for the same money twice.
    const summary = billableItems({
      jobs: [],
      rentals: [rental({ totalPence: 56000, paidPence: 40000 })],
    });

    expect(summary.rentalPence).toBe(16000);
    expect(summary.items[0]?.amountPence).toBe(16000);
  });

  it('leaves a fully-settled hire off the invoice entirely', () => {
    // Not a zero line somebody has to think about.
    const summary = billableItems({
      jobs: [],
      rentals: [rental({ totalPence: 56000, paidPence: 56000 })],
    });

    expect(summary.items).toHaveLength(0);
    expect(summary.rentalPence).toBe(0);
  });

  it('leaves an overpaid hire off too, rather than billing a negative', () => {
    const summary = billableItems({
      jobs: [],
      rentals: [rental({ totalPence: 56000, paidPence: 60000 })],
    });
    expect(summary.items).toHaveLength(0);
  });

  it('shows an already-invoiced item without re-billing it', () => {
    // Visible, so nobody wonders where it went; excluded from the total, so
    // it cannot be charged twice.
    const summary = billableItems({
      jobs: [job({ invoicedLineId: 'line-1' })],
      rentals: [rental()],
    });

    expect(summary.items).toHaveLength(2);
    expect(summary.jobPence).toBe(0);
    expect(summary.totalPence).toBe(56000);
    expect(summary.invoicedPence).toBe(40000);
  });

  it('names the car and the driver on a rental line', () => {
    // An invoice line reading "Vehicle hire" and nothing else is one the
    // recipient has to ring up about.
    const summary = billableItems({ jobs: [], rentals: [rental()] });
    expect(summary.items[0]?.description).toContain('AB12 CDE');
    expect(summary.items[0]?.description).toContain('Sam Okafor');
    expect(summary.items[0]?.description).toContain('RNT-000001');
  });

  it('orders by when things happened', () => {
    const summary = billableItems({
      jobs: [job({ occurredAt: d('2026-06-15') })],
      rentals: [rental({ occurredAt: d('2026-06-12') })],
    });
    expect(summary.items.map((item) => item.kind)).toEqual(['RENTAL', 'JOB']);
  });

  it('totals zero for an empty period', () => {
    const summary = billableItems({ jobs: [], rentals: [] });
    expect(summary.totalPence).toBe(0);
    expect(summary.items).toEqual([]);
  });
});

describe('revenueForPeriod', () => {
  it('counts what was earned, invoiced or not', () => {
    // Deliberately different from billing: a hire settled in cash is still
    // revenue, even though there is nothing left to invoice.
    const breakdown = revenueForPeriod({
      jobs: [{ totalPence: 40000 }, { totalPence: 30000 }],
      rentals: [{ totalPence: 56000 }],
    });

    expect(breakdown.jobPence).toBe(70000);
    expect(breakdown.rentalPence).toBe(56000);
    expect(breakdown.totalPence).toBe(126000);
    expect(breakdown.jobCount).toBe(2);
    expect(breakdown.rentalCount).toBe(1);
  });

  it('keeps rental revenue visible even when jobs earned nothing', () => {
    // A month where the fleet was all out on hire is not a month with no
    // revenue, and a report saying so would be wrong.
    const breakdown = revenueForPeriod({
      jobs: [],
      rentals: [{ totalPence: 56000 }],
    });
    expect(breakdown.totalPence).toBe(56000);
    expect(breakdown.rentalPence).toBe(56000);
  });
});
