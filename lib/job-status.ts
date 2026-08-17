import type { JobEventType, JobStatus } from '@prisma/client';

/**
 * The job lifecycle, and what it refuses.
 *
 * From `docs/data-model.md`:
 *
 * ```
 * DRAFT ──► PENDING ──► ASSIGNED ──► ACCEPTED ──► IN_PROGRESS ──► COMPLETED
 *              │            │            │              │             │
 *              └────────────┴────────────┴──────────────┴─────────────┴──► CANCELLED
 *                                        └──────────────────► NO_SHOW
 * ```
 *
 * The last of those arrows is the one the diagram did not have. A job marked
 * completed by mistake — the wrong one of two picked off the board, or a
 * transfer the client stood down after the driver had already been sent —
 * had no way back, and the only remedy on offer was to leave a job on the
 * books that never happened. It may be cancelled, provided it has not been
 * put on an invoice: past that point the client is holding a document that
 * says otherwise, and the remedy is a credit note.
 *
 * Everything here is pure. The rules are the part of the system most likely
 * to be argued about later, so they are stated once, in one place, and tested
 * exhaustively rather than being spread across route handlers.
 *
 * The guards matter more than the graph. A job that reaches `COMPLETED`
 * without a price is precisely the defect this rebuild exists to fix — in the
 * legacy system 140 of 141 jobs were worth £0 because nothing ever asked.
 */

/** Where each status may legally go next. Terminal states have no exits. */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ACCEPTED', 'IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  ACCEPTED: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  // Cancelling is the only way out, and the invoice guard below decides
  // whether it is open.
  COMPLETED: ['CANCELLED'],
  CANCELLED: [],
  NO_SHOW: [],
};

/** The event recorded when a job enters each status. */
const STATUS_EVENT: Record<JobStatus, JobEventType | null> = {
  DRAFT: null,
  PENDING: null,
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'ON_WAY',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
};

/**
 * Statuses at which the work has finished, for counting and filtering.
 *
 * Not the same thing as "cannot change": a completed job can still be
 * cancelled. Use `allowedTransitions` for that question.
 */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The statuses a job in `status` may move to, ignoring the data guards. */
export function allowedTransitions(status: JobStatus): readonly JobStatus[] {
  return TRANSITIONS[status];
}

export function eventTypeForStatus(status: JobStatus): JobEventType | null {
  return STATUS_EVENT[status];
}

/**
 * Refusal codes map to the HTTP responses in `docs/api-spec.md`, so a route
 * handler can translate without re-deciding what went wrong.
 */
export type TransitionRefusalCode =
  | 'INVALID_TRANSITION'
  | 'PRICE_REQUIRED'
  | 'DOCUMENT_EXPIRED'
  | 'INVOICE_LOCKED';

export type TransitionResult =
  | { ok: true }
  | { ok: false; code: TransitionRefusalCode; message: string; reasons?: string[] };

/**
 * What the guards need to know about a job. Deliberately not the Prisma row —
 * keeping it structural is what lets these rules be tested without a database.
 */
export interface TransitionContext {
  status: JobStatus;
  driverId: string | null;
  vehicleId: string | null;
  clientPricePence: number | null;
  zeroValueReason: string | null;
  /**
   * The hourly total, for an as-directed job. Without it `canTransition`
   * refuses to complete work that is fully priced — see
   * `billableClientPence`.
   */
  finance?: { totalClientPence: number } | null;
  /**
   * Set when the job sits on an invoice. `issued` separates the two remedies:
   * an invoice that has left draft is a document the client is holding and
   * needs a credit note, while a draft one only needs the line taking off it.
   *
   * Passed in rather than derived here so this module stays free of the
   * invoice rules — and of the Prisma types they are written against.
   */
  lockedByInvoice?: { reference: string; status: string; issued: boolean } | null;
  /** Result of `isDriverCompliantAt(scheduledAt)`, when assignment is in play. */
  compliance?: { compliant: boolean; reasons: string[] } | null;
}

/**
 * May this job move to `next`?
 *
 * Order matters: the graph is checked first, so "you cannot cancel a
 * completed job" is never reported as a pricing problem.
 */
export function canTransition(
  job: TransitionContext,
  next: JobStatus,
): TransitionResult {
  if (job.status === next) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `This job is already ${describeStatus(next)}`,
    };
  }

  const exits = TRANSITIONS[job.status];
  if (!exits.includes(next)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      // "Cannot change status" is only true where nothing at all is allowed.
      // A completed job has one way out, so it gets the specific refusal
      // rather than one that reads as though the job were sealed.
      message:
        exits.length === 0
          ? `This job is ${describeStatus(job.status)} and cannot change status`
          : `A ${describeStatus(job.status)} job cannot become ${describeStatus(next)}`,
    };
  }

  if (next === 'ASSIGNED') {
    const missing: string[] = [];
    if (!job.driverId) missing.push('a driver');
    if (!job.vehicleId) missing.push('a vehicle');
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        message: `Assigning a job needs ${missing.join(' and ')}`,
      };
    }

    // Licensing, not preference: putting an out-of-date badge or a lapsed MOT
    // on a job risks the operator licence.
    if (job.compliance && !job.compliance.compliant) {
      return {
        ok: false,
        code: 'DOCUMENT_EXPIRED',
        message: 'That driver or vehicle cannot be assigned to a job',
        reasons: job.compliance.reasons,
      };
    }
  }

  if (next === 'COMPLETED' && !hasPriceOrReason(job)) {
    return {
      ok: false,
      code: 'PRICE_REQUIRED',
      message:
        'This job has no client price. Add one, or record why it is zero-value, before completing it.',
    };
  }

  if (next === 'CANCELLED' && job.lockedByInvoice) {
    const invoice = job.lockedByInvoice;
    return {
      ok: false,
      code: 'INVOICE_LOCKED',
      message: invoice.issued
        ? `This job is on invoice ${invoice.reference}, which has been ` +
          `${invoice.status.toLowerCase()}. Raise a credit note rather than cancelling it.`
        : // A draft invoice can still be changed, so the fix is cheap — but it
          // has to happen, because cancelling underneath the draft leaves a
          // line for work that is not going to be done, and nothing on the
          // invoice says so before it goes out.
          `This job is on draft invoice ${invoice.reference}. Remove it from that ` +
          `invoice first, then cancel it.`,
    };
  }

  return { ok: true };
}

/**
 * What a job is worth to the client, from wherever that figure lives.
 *
 * **There are two homes for it, and this is the bug that made hourly work
 * unbillable.** A `TRANSFER` is a fixed fare and carries it in
 * `clientPricePence`. An `AS_DIRECTED` job is priced by the hour, so its
 * figure is `customerHours × customerRatePence`, computed at booking and
 * stored on `JobFinance.totalClientPence` — `clientPricePence` stays null
 * because there is no fixed fare to put in it.
 *
 * Every "is this priced?" check read only the first of those. The result was
 * a four-hour job at £59/hour showing "Revenue £236.00" and a gross profit on
 * the same page that said "Client price: No", flew the unpriced alert, and
 * refused completion — and since invoicing draws on completed jobs, no
 * as-directed job could be billed at all without somebody retyping the total
 * into the fixed-price field.
 *
 * As-directed hire is one of three job types, so this is not an edge case.
 */
export function billableClientPence(job: PricedJob): number {
  const fixed = job.clientPricePence ?? 0;
  const hourly = job.finance?.totalClientPence ?? 0;
  // Whichever is set. The finance total already includes the base fare when
  // there is one, so this is a max rather than a sum — adding them would
  // double-count a job that has both.
  return Math.max(fixed, hourly);
}

export interface PricedJob {
  clientPricePence: number | null;
  zeroValueReason: string | null;
  /**
   * The finance record, when the caller has it. Absent means "not loaded",
   * not "zero" — so a caller that forgets it gets the old, wrong answer for
   * hourly jobs. Every call site in this repository passes it; the field is
   * optional only because a job genuinely may not have a finance row.
   */
  finance?: { totalClientPence: number } | null;
}

/**
 * A job is priced if money changed hands, or if someone said in writing why
 * it did not. A blank reason is not a reason.
 */
export function hasPriceOrReason(job: PricedJob): boolean {
  if (billableClientPence(job) > 0) return true;
  return (job.zeroValueReason ?? '').trim().length > 0;
}

/** A job that has been done but never priced — what the dashboard counts. */
export function isUnpriced(job: PricedJob & { status: JobStatus }): boolean {
  return !hasPriceOrReason(job);
}

export function describeStatus(status: JobStatus): string {
  return STATUS_LABELS[status].toLowerCase();
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

/**
 * The preset reasons offered when completing a zero-value job (spec 2.4.6).
 * Free text is always allowed alongside these — the point is to make the
 * common answers one click rather than to constrain the honest ones.
 */
export const ZERO_VALUE_REASONS = [
  'Goodwill',
  'Cancelled in transit',
  'Internal transfer',
  'Duplicate booking',
] as const;
