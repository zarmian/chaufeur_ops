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

/**
 * The longest a single shift can be recorded as.
 *
 * Not a rule about how long anybody may work — it is a typo catcher, and it
 * exists because of backdating. Entering a shift as it happens is bounded by
 * the clock; entering one for last Tuesday is bounded by nothing, and a
 * mistyped year pays a driver for three hundred and sixty-five days. A
 * genuinely longer stretch is recorded as two shifts, which is also how it
 * should appear on a statement.
 */
export const LONGEST_SHIFT_HOURS = 24;

/** A shift's span, for asking whether two of them collide. */
export interface ShiftPeriod {
  reference: string;
  startedAt: Date;
  /** Null while the shift is still open. */
  endedAt: Date | null;
}

/**
 * Whether two shifts cover any of the same time.
 *
 * An open shift is treated as running on forever rather than up to now. It is
 * the conservative reading and the correct one: those hours are still being
 * counted, so anything starting after it began is time that will be paid
 * twice. A period entirely before it is fine.
 *
 * Half-open, so a shift ending at 14:00 and one starting at 14:00 do not
 * collide — handing a car over at the top of the hour is the normal case, not
 * an error.
 */
export function shiftsOverlap(
  left: { startedAt: Date; endedAt: Date | null },
  right: { startedAt: Date; endedAt: Date | null },
): boolean {
  const leftEnd = left.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightEnd = right.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;

  return left.startedAt.getTime() < rightEnd && right.startedAt.getTime() < leftEnd;
}

/**
 * May this already-worked shift be recorded?
 *
 * Separate from `canOpenShift` because it answers a different question. That
 * one asks whether a driver may clock on, and its whole content is the
 * one-open-shift rule. This one is about work that has already happened, so
 * the one-open-shift rule does not apply — a driver clocked on right now may
 * perfectly well have worked last Tuesday — and three checks that could be
 * left implicit before have to be made explicit.
 *
 * The one that matters is the clash. Until now a shift could only be created
 * at the moment it started, and the one-open-shift rule stood in for an
 * overlap check. Recording past work removes that protection: the same
 * Tuesday entered twice, or a stretch that overlaps one already recorded,
 * pays a driver twice for the same hours and nothing downstream would notice
 * — a payout is built from shifts, and two shifts are two payments.
 */
export function canRecordShift(
  times: { startedAt: Date; endedAt: Date; breakMinutes: number },
  options: { now: Date; clash: ShiftPeriod | null },
): ShiftRefusal {
  if (times.endedAt.getTime() <= times.startedAt.getTime()) {
    return { ok: false, message: 'A shift has to end after it started' };
  }

  // Unlike closing a shift, which happens at the moment work stops, this is a
  // claim that work is already done. A shift that has not happened yet cannot
  // be.
  if (times.endedAt.getTime() > options.now.getTime()) {
    return {
      ok: false,
      message: 'That shift has not finished yet — record it once it has.',
    };
  }

  const elapsed = Math.round(
    (times.endedAt.getTime() - times.startedAt.getTime()) / 60000,
  );

  if (elapsed > LONGEST_SHIFT_HOURS * 60) {
    return {
      ok: false,
      message: `That is ${Math.round(elapsed / 60)} hours long. Check the dates — anything over ${LONGEST_SHIFT_HOURS} hours is recorded as separate shifts.`,
    };
  }

  if (times.breakMinutes > elapsed) {
    return {
      ok: false,
      message: `The break is longer than the shift — ${times.breakMinutes} minutes of break in ${elapsed} minutes worked`,
    };
  }

  if (options.clash) {
    return {
      ok: false,
      message: `${options.clash.reference} already covers some of that time for this driver.`,
    };
  }

  return { ok: true };
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
