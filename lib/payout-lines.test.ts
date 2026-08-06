import { describe, expect, it } from 'vitest';
import {
  buildPayoutLines,
  type PayoutExpense,
  type PayoutJob,
  type PayoutShift,
} from './payout-lines';

/**
 * What a driver is owed, and the rule that stops them being paid twice.
 *
 * A driver hired to drive one of the company's own cars is paid for the
 * hours, not the runs — the jobs inside that shift belong to the company and
 * carry no driver fee. If a payout counted both, an eight-hour shift with six
 * airport runs in it would pay for the shift *and* six fees.
 */

const d = (iso: string) => new Date(`${iso}T09:00:00Z`);

function job(overrides: Partial<PayoutJob> = {}): PayoutJob {
  return {
    id: 'job-1',
    reference: 'JOB-000001',
    scheduledAt: d('2026-06-10'),
    driverPricePence: 8000,
    shiftId: null,
    ...overrides,
  };
}

function shift(overrides: Partial<PayoutShift> = {}): PayoutShift {
  return {
    id: 'shift-1',
    reference: 'SHF-000001',
    startedAt: d('2026-06-11'),
    endedAt: d('2026-06-11'),
    payPence: 15300,
    approvedAt: d('2026-06-12'),
    ...overrides,
  };
}

describe('per-job pay', () => {
  it('makes a line per job at the driver price', () => {
    const draft = buildPayoutLines({
      jobs: [job(), job({ id: 'job-2', reference: 'JOB-000002', driverPricePence: 12000 })],
      shifts: [],
    });

    expect(draft.lines).toHaveLength(2);
    expect(draft.jobPence).toBe(20000);
    expect(draft.totalPence).toBe(20000);
    expect(draft.lines[0]!.description).toBe('Job JOB-000001');
  });

  it('reports an unpriced job rather than quietly dropping it', () => {
    // A payout that silently omits a job is how a driver ends up short and
    // nobody can say why.
    const draft = buildPayoutLines({
      jobs: [job({ driverPricePence: null })],
      shifts: [],
    });

    expect(draft.lines).toHaveLength(0);
    expect(draft.excluded[0]?.reference).toBe('JOB-000001');
    expect(draft.excluded[0]?.reason).toMatch(/No driver price/);
  });
});

describe('shift pay', () => {
  it('makes a line for an approved, closed shift', () => {
    const draft = buildPayoutLines({ jobs: [], shifts: [shift()] });

    expect(draft.lines).toHaveLength(1);
    expect(draft.shiftPence).toBe(15300);
    expect(draft.lines[0]!.source).toBe('SHIFT');
    expect(draft.lines[0]!.shiftId).toBe('shift-1');
    expect(draft.lines[0]!.jobId).toBeNull();
  });

  it('leaves an open shift out — it has no end to pay to', () => {
    const draft = buildPayoutLines({
      jobs: [],
      shifts: [shift({ endedAt: null, payPence: null })],
    });
    expect(draft.lines).toHaveLength(0);
    expect(draft.excluded[0]?.reason).toMatch(/Still open/);
  });

  it('leaves an unapproved shift out, and says so', () => {
    const draft = buildPayoutLines({
      jobs: [],
      shifts: [shift({ approvedAt: null })],
    });
    expect(draft.lines).toHaveLength(0);
    expect(draft.excluded[0]?.reason).toMatch(/Not approved/);
  });

  it('can pay unapproved shifts when approval is not required', () => {
    const draft = buildPayoutLines({
      jobs: [],
      shifts: [shift({ approvedAt: null })],
      requireApprovedShifts: false,
    });
    expect(draft.lines).toHaveLength(1);
  });
});

describe('never paying twice', () => {
  it('drops a job covered by a shift', () => {
    // The rule the whole module exists for.
    const draft = buildPayoutLines({
      jobs: [job({ shiftId: 'shift-1', driverPricePence: 8000 })],
      shifts: [shift()],
    });

    expect(draft.jobPence).toBe(0);
    expect(draft.shiftPence).toBe(15300);
    expect(draft.totalPence).toBe(15300);
    expect(draft.excluded[0]?.reason).toMatch(/Covered by a shift/);
  });

  it('pays a shift and any jobs outside it', () => {
    // A driver can do both in one week: hired hours on Monday, their own car
    // on Tuesday.
    const draft = buildPayoutLines({
      jobs: [
        job({ id: 'in', reference: 'JOB-000001', shiftId: 'shift-1' }),
        job({
          id: 'out',
          reference: 'JOB-000002',
          scheduledAt: d('2026-06-12'),
          driverPricePence: 9000,
        }),
      ],
      shifts: [shift()],
    });

    expect(draft.jobPence).toBe(9000);
    expect(draft.shiftPence).toBe(15300);
    expect(draft.totalPence).toBe(24300);
  });

  it('never emits a line with both a job and a shift', () => {
    // The database enforces this too; here it is the shape of the draft.
    const draft = buildPayoutLines({
      jobs: [job()],
      shifts: [shift()],
    });

    for (const line of draft.lines) {
      const sources = [line.jobId, line.shiftId].filter(Boolean);
      expect(sources).toHaveLength(1);
    }
  });
});

describe('the settled figure beats the booked one', () => {
  it('pays what the finance record says when there is one', () => {
    // The finance panel is where a fee actually gets adjusted — waiting time
    // agreed after the job, a correction. Paying the booking price when a
    // settled figure exists would quietly short the driver.
    const draft = buildPayoutLines({
      jobs: [job({ driverPricePence: 8000, financeDriverPaymentPence: 9250 })],
      shifts: [],
    });

    expect(draft.lines[0]?.amountPence).toBe(9250);
    expect(draft.totalPence).toBe(9250);
  });

  it('falls back to the booking price when nothing was settled', () => {
    const draft = buildPayoutLines({
      jobs: [job({ driverPricePence: 8000, financeDriverPaymentPence: null })],
      shifts: [],
    });

    expect(draft.lines[0]?.amountPence).toBe(8000);
  });

  it('excludes a job settled at nothing rather than paying the booked price', () => {
    // A zero on the finance record is a statement, not an absence — and a
    // payout that quietly substituted the booking price would be paying a
    // figure somebody deliberately overrode.
    const draft = buildPayoutLines({
      jobs: [job({ driverPricePence: 8000, financeDriverPaymentPence: 0 })],
      shifts: [],
    });

    expect(draft.lines).toEqual([]);
    expect(draft.excluded[0]?.reason).toContain('No driver price');
  });
});

describe('reimbursed expenses', () => {
  function expense(overrides: Partial<PayoutExpense> = {}): PayoutExpense {
    return {
      id: 'exp-1',
      jobId: 'job-1',
      jobReference: 'JOB-000001',
      occurredAt: d('2026-06-10'),
      kind: 'PARKING',
      amountPence: 1200,
      note: null,
      ...overrides,
    };
  }

  it('adds a line of its own rather than folding into the fee', () => {
    // A driver checking a payout against their receipts needs the parking to
    // appear as parking.
    const draft = buildPayoutLines({
      jobs: [job()],
      shifts: [],
      expenses: [expense()],
    });

    expect(draft.lines).toHaveLength(2);
    expect(draft.jobPence).toBe(8000);
    expect(draft.expensePence).toBe(1200);
    expect(draft.totalPence).toBe(9200);
  });

  it('names the expense and the job it belongs to', () => {
    const draft = buildPayoutLines({
      jobs: [],
      shifts: [],
      expenses: [expense({ kind: 'CONGESTION_CHARGE', note: 'inbound' })],
    });

    expect(draft.lines[0]?.description).toBe(
      'Congestion charge on JOB-000001 — inbound',
    );
    // Traceable: a reimbursement pointing at nothing is unanswerable the
    // moment anybody queries it.
    expect(draft.lines[0]?.jobId).toBe('job-1');
  });

  it('ignores an expense of nothing', () => {
    const draft = buildPayoutLines({
      jobs: [],
      shifts: [],
      expenses: [expense({ amountPence: 0 })],
    });
    expect(draft.lines).toEqual([]);
  });

  it('reimburses on a shift-paid job, which carries no fee of its own', () => {
    // The fee is excluded because the shift covers it; the parking is not,
    // because the driver is still out of pocket for it.
    const draft = buildPayoutLines({
      jobs: [job({ shiftId: 'shift-1' })],
      shifts: [shift()],
      expenses: [expense()],
    });

    expect(draft.jobPence).toBe(0);
    expect(draft.shiftPence).toBe(15300);
    expect(draft.expensePence).toBe(1200);
    expect(draft.totalPence).toBe(16500);
  });
});

describe('ordering', () => {
  it('reads chronologically, not jobs-then-shifts', () => {
    // A statement should read as the week happened.
    const draft = buildPayoutLines({
      jobs: [job({ scheduledAt: d('2026-06-13') })],
      shifts: [shift({ startedAt: d('2026-06-11'), endedAt: d('2026-06-11') })],
    });

    expect(draft.lines.map((line) => line.source)).toEqual(['SHIFT', 'JOB']);
  });
});

describe('an empty period', () => {
  it('totals zero without inventing lines', () => {
    const draft = buildPayoutLines({ jobs: [], shifts: [] });
    expect(draft.lines).toEqual([]);
    expect(draft.totalPence).toBe(0);
    expect(draft.expensePence).toBe(0);
    expect(draft.excluded).toEqual([]);
  });
});
