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
  /** Set when a shift covered this job, which means it carries no fee. */
  shiftId: string | null;
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

export type PayoutLineSource = 'JOB' | 'SHIFT';

export interface PayoutLineDraft {
  source: PayoutLineSource;
  jobId: string | null;
  shiftId: string | null;
  amountPence: number;
  description: string;
  /** What the line is ordered by, and what the period test applies to. */
  occurredAt: Date;
}

export interface PayoutDraft {
  lines: PayoutLineDraft[];
  jobPence: number;
  shiftPence: number;
  totalPence: number;
  /**
   * Things deliberately left out, and why. Surfaced rather than silently
   * dropped: a driver querying a short payment needs the answer to be
   * visible, not reconstructed.
   */
  excluded: Array<{ reference: string; reason: string }>;
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
      });
      continue;
    }

    if (job.driverPricePence === null || job.driverPricePence === 0) {
      // Not silently skipped. An unpriced job is a data-quality problem, and
      // a payout that quietly omits one is how a driver ends up short.
      excluded.push({
        reference: job.reference,
        reason: 'No driver price recorded — price it before paying it',
      });
      continue;
    }

    lines.push({
      source: 'JOB',
      jobId: job.id,
      shiftId: null,
      amountPence: job.driverPricePence,
      description: `Job ${job.reference}`,
      occurredAt: job.scheduledAt,
    });
  }

  for (const shift of input.shifts) {
    if (shift.endedAt === null) {
      excluded.push({
        reference: shift.reference,
        reason: 'Still open — a shift is paid once it has ended',
      });
      continue;
    }

    if (requireApproved && shift.approvedAt === null) {
      excluded.push({
        reference: shift.reference,
        reason: 'Not approved yet',
      });
      continue;
    }

    if (shift.payPence === null || shift.payPence === 0) {
      excluded.push({
        reference: shift.reference,
        reason: 'No payable hours after the unpaid break',
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

  // Chronological, so a statement reads as the period happened rather than
  // as jobs-then-shifts.
  lines.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const jobPence = sumPence(
    ...lines.filter((line) => line.source === 'JOB').map((line) => line.amountPence),
  );
  const shiftPence = sumPence(
    ...lines.filter((line) => line.source === 'SHIFT').map((line) => line.amountPence),
  );

  return {
    lines,
    jobPence,
    shiftPence,
    totalPence: jobPence + shiftPence,
    excluded,
  };
}
