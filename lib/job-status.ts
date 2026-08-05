import type { JobEventType, JobStatus } from '@prisma/client';

/**
 * The job lifecycle, and what it refuses.
 *
 * From `docs/data-model.md`:
 *
 * ```
 * DRAFT ──► PENDING ──► ASSIGNED ──► ACCEPTED ──► IN_PROGRESS ──► COMPLETED
 *              │            │            │              │
 *              └────────────┴────────────┴──────────────┴──► CANCELLED
 *                                        └──────────────────► NO_SHOW
 * ```
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
  COMPLETED: [],
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
  /** Set when the job sits on an invoice that has left draft. */
  lockedByInvoice?: { reference: string; status: string } | null;
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

  if (!TRANSITIONS[job.status].includes(next)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: isTerminal(job.status)
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
    return {
      ok: false,
      code: 'INVOICE_LOCKED',
      message:
        `This job is on invoice ${job.lockedByInvoice.reference}, which has been ` +
        `${job.lockedByInvoice.status.toLowerCase()}. Raise a credit note rather than cancelling it.`,
    };
  }

  return { ok: true };
}

/**
 * A job is priced if money changed hands, or if someone said in writing why
 * it did not. A blank reason is not a reason.
 */
export function hasPriceOrReason(job: {
  clientPricePence: number | null;
  zeroValueReason: string | null;
}): boolean {
  if ((job.clientPricePence ?? 0) > 0) return true;
  return (job.zeroValueReason ?? '').trim().length > 0;
}

/** A job that has been done but never priced — what the dashboard counts. */
export function isUnpriced(job: {
  status: JobStatus;
  clientPricePence: number | null;
  zeroValueReason: string | null;
}): boolean {
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
