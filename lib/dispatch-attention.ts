import { occupiedBy, type Occupies } from './conflicts';
import { progressOf, type ProgressEvent } from './job-progress';

/**
 * What needs somebody, and how badly.
 *
 * The dispatch board used to list unassigned work in pickup order and stop
 * there, which meant a job going in forty minutes looked exactly like one
 * going on Thursday, and a job whose pickup passed an hour ago with nobody
 * having started it did not appear at all. Both are the same failure: the
 * board reported *state* and left the reader to work out *urgency*.
 *
 * Pure, and separate from the query, for the reason `lib/job-status.ts` is:
 * these are the rules people argue about later — how late is late, how close
 * is close — so they are stated once, in one place, and tested exhaustively
 * rather than being spread through a page component.
 */

export type AttentionReason =
  /** Nobody on it, and the pickup is near or past. */
  | 'UNASSIGNED'
  /** The pickup has passed and nobody has started it. */
  | 'NOT_STARTED'
  /** Under way, but past when it should have finished. */
  | 'OVERRUNNING';

/**
 * Amber is "deal with this today", red is "deal with this now".
 *
 * Two levels rather than five. A scale finer than the decisions it drives is
 * a scale nobody calibrates — and the only decision here is whether to pick
 * up the phone before finishing the coffee.
 */
export type Severity = 'warning' | 'critical';

export interface AttentionJob extends Occupies {
  id: string;
  reference: string;
  status: string;
  driverId: string | null;
  scheduledAt: Date;
}

export interface AttentionItem {
  jobId: string;
  reference: string;
  reason: AttentionReason;
  severity: Severity;
  /**
   * The moment the clock started: the pickup for an unassigned or unstarted
   * job, the expected end for one that is overrunning. The page turns this
   * into "40m ago" so the wording lives with the formatting.
   */
  since: Date;
  /** Minutes either side of `since`. Negative means it has not happened yet. */
  minutes: number;
}

export interface AttentionThresholds {
  /** Pickup within this many hours and nobody on it — spec's "close". */
  unassignedHours: number;
  /** Grace after a pickup before "nobody has started it" counts. */
  lateMinutes: number;
}

export const DEFAULT_ATTENTION: AttentionThresholds = {
  unassignedHours: 4,
  lateMinutes: 15,
};

/** Statuses where nothing is owed: the job is over, one way or another. */
const FINISHED = ['COMPLETED', 'CANCELLED', 'NO_SHOW'];

/**
 * Everything wanting a dispatcher's attention, most urgent first.
 *
 * One item per job at most. A job that is both unassigned and past its pickup
 * is one problem, not two, and listing it twice would have somebody fix it and
 * then find it still there.
 */
export function attentionItems(
  jobs: (AttentionJob & { events?: ProgressEvent[] })[],
  now: Date = new Date(),
  thresholds: AttentionThresholds = DEFAULT_ATTENTION,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const job of jobs) {
    const item = assess(job, now, thresholds);
    if (item) items.push(item);
  }

  return items.sort(compare);
}

/**
 * The one thing wrong with this job, or nothing.
 *
 * Checked in order of consequence: a job nobody is on outranks one that is
 * merely running behind, because somewhere a client is standing outside with a
 * bag and no car is coming.
 */
function assess(
  job: AttentionJob & { events?: ProgressEvent[] },
  now: Date,
  thresholds: AttentionThresholds,
): AttentionItem | null {
  if (FINISHED.includes(job.status)) return null;

  const base = { jobId: job.id, reference: job.reference };
  const minutesTo = (instant: Date) =>
    Math.round((now.getTime() - instant.getTime()) / 60_000);

  if (!job.driverId) {
    const minutes = minutesTo(job.scheduledAt);
    const withinWindow = minutes >= -thresholds.unassignedHours * 60;
    if (!withinWindow) return null;

    return {
      ...base,
      reason: 'UNASSIGNED',
      // Past its pickup with nobody on it is the worst thing this board can
      // show. Inside the window but still to come is a job somebody has time
      // to fix.
      severity: minutes >= 0 ? 'critical' : 'warning',
      since: job.scheduledAt,
      minutes,
    };
  }

  /*
   * Somebody is on it — so the question is whether they have moved.
   *
   * From the events rather than the status, because `ASSIGNED` covers both a
   * driver who has not looked at their phone and one who is five minutes from
   * the pickup. Only the first needs chasing.
   */
  const progress = progressOf(job.events ?? [], now);
  const started =
    progress.milestone !== null &&
    progress.milestone !== 'ASSIGNED' &&
    progress.milestone !== 'ACCEPTED';

  if (!started) {
    const minutes = minutesTo(job.scheduledAt);
    if (minutes < thresholds.lateMinutes) return null;

    return {
      ...base,
      reason: 'NOT_STARTED',
      // An hour past the pickup with no sign of the driver is a different
      // conversation from ten minutes past.
      severity: minutes >= 60 ? 'critical' : 'warning',
      since: job.scheduledAt,
      minutes,
    };
  }

  // Under way. The only thing left to be wrong is that it has not ended.
  if (progress.milestone === 'COMPLETED') return null;

  const expectedEnd = occupiedBy(job).to;
  const minutes = minutesTo(expectedEnd);
  if (minutes < thresholds.lateMinutes) return null;

  return {
    ...base,
    reason: 'OVERRUNNING',
    // A job still open a full hour after it should have finished is usually
    // one the driver forgot to close, and it is holding up their next.
    severity: minutes >= 60 ? 'critical' : 'warning',
    since: expectedEnd,
    minutes,
  };
}

/** Critical before warning, then whatever has been wrong longest. */
function compare(a: AttentionItem, b: AttentionItem): number {
  if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
  if (a.minutes !== b.minutes) return b.minutes - a.minutes;
  return a.reference.localeCompare(b.reference);
}

export const REASON_LABELS: Record<AttentionReason, string> = {
  UNASSIGNED: 'Nobody on it',
  NOT_STARTED: 'Not started',
  OVERRUNNING: 'Not closed off',
};

/**
 * What to do about it, in a few words.
 *
 * On the row rather than in a help page: a flag that does not say what it
 * wants is a flag people learn to scroll past.
 */
export const REASON_HINTS: Record<AttentionReason, string> = {
  UNASSIGNED: 'Give it to a driver',
  NOT_STARTED: 'Check the driver has seen it',
  OVERRUNNING: 'Check it finished, then close it off',
};
