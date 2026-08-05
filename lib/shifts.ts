import { roundPence, sumPence } from './money';

/**
 * Shifts — how a hired driver's time is paid for.
 *
 * A shift may cover several jobs, one job, or none (a driver on standby who
 * got no work is still owed for the hours). That is the whole reason it
 * exists as a record rather than as fields on a job: under the hired model
 * there is no per-job driver fee to record, and pretending otherwise is what
 * would make gross profit wrong.
 *
 * The rate lives on the shift, copied in when it opens. A rate rise must not
 * silently re-price shifts already worked.
 */

export const SHIFT_REFERENCE_PREFIX = 'SHF';
export const SHIFT_REFERENCE_PAD = 6;

export interface ShiftTimes {
  startedAt: Date;
  /** Null while the shift is still open. */
  endedAt: Date | null;
  breakMinutes: number;
}

/**
 * Paid minutes: elapsed time less the unpaid break, floored at zero.
 *
 * An open shift returns null rather than measuring to "now" — a figure that
 * changes every time you look at it is not a number anyone can be paid on.
 * Callers that want a running total ask for it explicitly.
 */
export function paidMinutes(shift: ShiftTimes): number | null {
  if (!shift.endedAt) return null;
  return paidMinutesTo(shift, shift.endedAt);
}

/** Paid minutes as at `at` — for showing an open shift's running total. */
export function paidMinutesTo(shift: ShiftTimes, at: Date): number {
  const elapsed = Math.round((at.getTime() - shift.startedAt.getTime()) / 60000);
  return Math.max(0, elapsed - Math.max(0, shift.breakMinutes));
}

/**
 * What the shift pays.
 *
 * Rounded once, at the point minutes become money — the same rule the finance
 * panel uses, so a driver statement and a job total never disagree by a penny.
 */
export function shiftPayPence(
  shift: ShiftTimes & { hourlyRatePence: number },
): number | null {
  const minutes = paidMinutes(shift);
  if (minutes === null) return null;
  return roundPence((minutes / 60) * shift.hourlyRatePence);
}

export function isOpen(shift: { endedAt: Date | null }): boolean {
  return shift.endedAt === null;
}

export type ShiftRefusal =
  | { ok: true }
  | { ok: false; message: string };

/**
 * May this driver start a shift now?
 *
 * One open shift at a time. Two would make "how long did they work"
 * unanswerable, and the refusal names the open one so the operator can go and
 * close it rather than guessing what is wrong.
 */
export function canOpenShift(
  openShift: { reference: string; startedAt: Date } | null,
): ShiftRefusal {
  if (!openShift) return { ok: true };
  return {
    ok: false,
    message: `${openShift.reference} is still open for this driver. End it before starting another.`,
  };
}

/** May this shift be closed at `endedAt`? */
export function canCloseShift(
  shift: ShiftTimes,
  endedAt: Date,
): ShiftRefusal {
  if (shift.endedAt) {
    return { ok: false, message: 'That shift has already ended' };
  }
  if (endedAt.getTime() < shift.startedAt.getTime()) {
    return { ok: false, message: 'A shift cannot end before it started' };
  }
  const elapsed = Math.round((endedAt.getTime() - shift.startedAt.getTime()) / 60000);
  if (shift.breakMinutes > elapsed) {
    return {
      ok: false,
      message: `The break is longer than the shift — ${shift.breakMinutes} minutes of break in ${elapsed} minutes worked`,
    };
  }
  return { ok: true };
}

export interface ShiftJobSummary {
  /** Revenue attributed to the job. */
  revenuePence: number;
  /** Expenses on that job the company bore. */
  companyExpensePence: number;
}

export interface ShiftProfit {
  revenuePence: number;
  payPence: number;
  expensePence: number;
  grossProfitPence: number;
  marginPct: number | null;
}

/**
 * Shift profitability (spec 2.5.2.7).
 *
 * This is where a hired driver's economics actually live: the revenue of the
 * jobs they did, less what they were paid for the time and what the company
 * spent running the car. Per-job gross profit cannot answer it, because the
 * cost was never per-job.
 */
export function shiftProfit(
  pay: number | null,
  jobs: ShiftJobSummary[],
): ShiftProfit {
  const revenuePence = sumPence(...jobs.map((job) => job.revenuePence));
  const expensePence = sumPence(...jobs.map((job) => job.companyExpensePence));
  const payPence = pay ?? 0;
  const grossProfitPence = revenuePence - payPence - expensePence;

  return {
    revenuePence,
    payPence,
    expensePence,
    grossProfitPence,
    // Consistent with marginPct in lib/money.ts: no revenue means no margin,
    // not a margin of zero.
    marginPct:
      revenuePence === 0
        ? null
        : Math.round((grossProfitPence / revenuePence) * 10000) / 100,
  };
}

/** `95 -> "1h 35m"`. Shifts are read in hours, not minutes. */
export function formatShiftLength(minutes: number | null): string {
  if (minutes === null) return 'Still open';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
