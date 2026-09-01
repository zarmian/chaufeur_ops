import { sumPence } from './money';

/**
 * What a driver is owed for a period, and where each pound came from.
 *
 * A driver is paid two different ways and a payout has to hold both:
 *
 * - **Per job.** An owner-driver is paid a fee for each job they run. The
 *   line is the job's driver price.
 * - **Per hour.** A driver hired to drive one of the company's own cars is
 *   paid for the shift, not the jobs — the jobs inside that shift belong to
 *   the company and carry no driver fee at all.
 *
 * Getting this wrong pays somebody twice. A shift-paid driver whose jobs also
 * carried a fee would be paid for the hours *and* for each run inside them,
 * so a job attached to a shift never produces a line of its own. That rule
 * lives here rather than in the query, because it is the part that has to be
 * obviously right.
 *
 * Pure, so the arithmetic can be tested without a database.
 */

export interface PayoutJob {
  id: string;
  reference: string;
  scheduledAt: Date;
  driverPricePence: number | null;
  /**
   * What the finance record says the driver is paid — spec 4.5.2.
   *
   * Preferred over `driverPricePence` when there is one, because the finance
   * panel is where a fee actually gets adjusted: waiting time agreed after
   * the job, an hourly driver's hours, a correction. The booking price is
   * what was expected; this is what was settled on, and paying the first when
   * the second exists would quietly short the driver.
   */
  financeDriverPaymentPence?: number | null;
  /** Set when a shift covered this job, which means it carries no fee. */
  shiftId: string | null;
}

/**
 * An expense the driver paid out of their own pocket — spec 4.5.8.
 *
 * Reimbursed as its own line rather than folded into a job's fee: a driver
 * checking a payout against their receipts needs the parking to appear as
 * parking. Only expenses somebody approved, and only ones the driver is not
 * meant to bear themselves — an owner-driver's own fuel is a cost of their
 * business, not something the company owes them.
 */
export interface PayoutExpense {
  id: string;
  jobId: string;
  jobReference: string;
  occurredAt: Date;
  kind: string;
  amountPence: number;
  note: string | null;
}

export interface PayoutShift {
  id: string;
  reference: string;
  startedAt: Date;
  endedAt: Date | null;
  /** Pay for the shift, already computed by `shiftPayPence`. */
  payPence: number | null;
  approvedAt: Date | null;
}

export type PayoutLineSource = 'JOB' | 'SHIFT' | 'EXPENSE';

export interface PayoutLineDraft {
  source: PayoutLineSource;
  jobId: string | null;
  shiftId: string | null;
  amountPence: number;
  description: string;
  /** What the line is ordered by, and what the period test applies to. */
  occurredAt: Date;
}

/**
 * Why a record is not on the payout.
 *
 * The `reason` beside it is written for an operator looking at the generate
 * screen. Drivers now see the same exclusions in Telegram and need different
 * words — "price it before paying it" is an instruction to the office, not to
 * the person waiting for the money. The code is what a second audience
 * translates from, so neither phrasing has to match the other by string.
 */
export type PayoutExclusion =
  | 'ALREADY_PAID'
  | 'SHIFT_COVERED'
  | 'UNPRICED'
  | 'SHIFT_OPEN'
  | 'SHIFT_UNAPPROVED'
  | 'SHIFT_NO_HOURS';

export interface PayoutDraft {
  lines: PayoutLineDraft[];
  jobPence: number;
  shiftPence: number;
  expensePence: number;
  totalPence: number;
  /**
   * Things deliberately left out, and why. Surfaced rather than silently
   * dropped: a driver querying a short payment needs the answer to be
   * visible, not reconstructed.
   */
  excluded: Array<{
    reference: string;
    reason: string;
    code: PayoutExclusion;
  }>;
}

/**
 * Build the lines for one driver over one period.
 *
 * Both ends of the period are the caller's business; this only decides what
 * each record is worth and whether it belongs.
 */
export function buildPayoutLines(input: {
  jobs: PayoutJob[];
  shifts: PayoutShift[];
  /** Approved, driver-paid expenses to reimburse. */
  expenses?: PayoutExpense[];
  /** Shifts must be approved before they are paid, unless this is off. */
  requireApprovedShifts?: boolean;
}): PayoutDraft {
  const requireApproved = input.requireApprovedShifts ?? true;
  const lines: PayoutLineDraft[] = [];
  const excluded: PayoutDraft['excluded'] = [];

  for (const job of input.jobs) {
    // The rule that stops a driver being paid twice.
    if (job.shiftId) {
      excluded.push({
        reference: job.reference,
        reason: 'Covered by a shift, which is paid by the hour instead',
        code: 'SHIFT_COVERED',
      });
      continue;
    }

    // The settled figure beats the booked one where there is a difference.
    const feePence = job.financeDriverPaymentPence ?? job.driverPricePence;

    if (feePence === null || feePence === 0) {
      // Not silently skipped. An unpriced job is a data-quality problem, and
      // a payout that quietly omits one is how a driver ends up short.
      excluded.push({
        reference: job.reference,
        reason: 'No driver price recorded — price it before paying it',
        code: 'UNPRICED',
      });
      continue;
    }

    lines.push({
      source: 'JOB',
      jobId: job.id,
      shiftId: null,
      amountPence: feePence,
      description: `Job ${job.reference}`,
      occurredAt: job.scheduledAt,
    });
  }

  for (const shift of input.shifts) {
    if (shift.endedAt === null) {
      excluded.push({
        reference: shift.reference,
        reason: 'Still open — a shift is paid once it has ended',
        code: 'SHIFT_OPEN',
      });
      continue;
    }

    if (requireApproved && shift.approvedAt === null) {
      excluded.push({
        reference: shift.reference,
        reason: 'Not approved yet',
        code: 'SHIFT_UNAPPROVED',
      });
      continue;
    }

    if (shift.payPence === null || shift.payPence === 0) {
      excluded.push({
        reference: shift.reference,
        reason: 'No payable hours after the unpaid break',
        code: 'SHIFT_NO_HOURS',
      });
      continue;
    }

    lines.push({
      source: 'SHIFT',
      jobId: null,
      shiftId: shift.id,
      amountPence: shift.payPence,
      description: `Shift ${shift.reference}`,
      occurredAt: shift.startedAt,
    });
  }

  for (const expense of input.expenses ?? []) {
    if (expense.amountPence === 0) continue;

    // Carried on the line as a job id: it *is* a cost of that job, and a
    // reimbursement that pointed at nothing would be untraceable the moment
    // anybody queried it.
    lines.push({
      source: 'EXPENSE',
      jobId: expense.jobId,
      shiftId: null,
      amountPence: expense.amountPence,
      description: `${expenseLabel(expense.kind)} on ${expense.jobReference}${
        expense.note ? ` — ${expense.note}` : ''
      }`,
      occurredAt: expense.occurredAt,
    });
  }

  // Chronological, so a statement reads as the period happened rather than
  // as jobs-then-shifts.
  lines.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const jobPence = sumPence(
    ...lines
      .filter((line) => line.source === 'JOB')
      .map((line) => line.amountPence),
  );
  const shiftPence = sumPence(
    ...lines
      .filter((line) => line.source === 'SHIFT')
      .map((line) => line.amountPence),
  );
  const expensePence = sumPence(
    ...lines
      .filter((line) => line.source === 'EXPENSE')
      .map((line) => line.amountPence),
  );

  return {
    lines,
    jobPence,
    shiftPence,
    expensePence,
    totalPence: jobPence + shiftPence + expensePence,
    excluded,
  };
}

/** `TOLL_CONGESTION` reads as "Toll congestion" on a statement. */
function expenseLabel(kind: string): string {
  const words = kind.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
