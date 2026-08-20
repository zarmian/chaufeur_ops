import type { JobEventType, JobStatus } from '@prisma/client';

/**
 * How far a job has actually got.
 *
 * `jobs.status` is a cache of the latest event, and it is coarse: `ASSIGNED`
 * covers a job the driver has not looked at and one they are ten minutes from
 * the pickup on. On a dispatch board that difference is the whole question —
 * the first needs chasing and the second needs leaving alone.
 *
 * The events already carry it. `lib/job-events.ts` builds the full timeline
 * for a job's own page; this reduces the same records to the one thing a board
 * needs: the furthest point reached, and how long it has been sitting there.
 *
 * Pure and import-free apart from the Prisma enum types, so it can be tested
 * without a database and can be imported from a Client Component.
 */

/**
 * The milestones a job passes through, in order.
 *
 * Only the six that describe progress. `CREATED`, `EDITED` and `PRICE_SET`
 * are bookkeeping — they say something happened to the record, not that the
 * work moved on — and the terminal refusals (`DECLINED`, `CANCELLED`,
 * `NO_SHOW`) are not a further step along this path but a departure from it,
 * handled by the status.
 */
export const MILESTONES = [
  'ASSIGNED',
  'ACCEPTED',
  'ON_WAY',
  'ARRIVED',
  'POB',
  'COMPLETED',
] as const;

export type Milestone = (typeof MILESTONES)[number];

/** Where each milestone sits on the path. Higher is further along. */
const RANK: Record<Milestone, number> = {
  ASSIGNED: 0,
  ACCEPTED: 1,
  ON_WAY: 2,
  ARRIVED: 3,
  POB: 4,
  COMPLETED: 5,
};

/**
 * What a dispatcher would say the driver is doing, in the present tense.
 *
 * Deliberately not `EVENT_LABELS` from `lib/job-events.ts`. Those are log
 * entries — "Arrived at pickup" is a thing that happened at 14:32. These are
 * states — "At pickup" is where the driver is now. A board wants the second.
 */
export const MILESTONE_LABELS: Record<Milestone, string> = {
  ASSIGNED: 'Sent to driver',
  ACCEPTED: 'Accepted',
  ON_WAY: 'On the way',
  ARRIVED: 'At pickup',
  POB: 'Passenger on board',
  COMPLETED: 'Done',
};

export function isMilestone(type: JobEventType): type is Milestone {
  return (MILESTONES as readonly string[]).includes(type);
}

export interface ProgressEvent {
  type: JobEventType;
  occurredAt: Date;
}

export interface JobProgress {
  /** The furthest milestone reached, or null if none has been. */
  milestone: Milestone | null;
  /** When it was reached. */
  at: Date | null;
  /** How far along the path, 0–1, for a stepper. */
  fraction: number;
  /** Minutes since the milestone was reached, given `now`. */
  minutesSince: number | null;
}

/**
 * The furthest milestone in a job's events.
 *
 * Furthest, not latest. The two differ, and taking the latest is wrong: a
 * driver who taps POB and then re-taps ARRIVED by mistake has not gone back
 * to the kerb, and a board that says so sends somebody to check on a job that
 * is halfway to Heathrow. Progress along this path only moves one way; the
 * corrections belong in the job's own timeline, where they are visible with
 * their timestamps.
 *
 * Ties are broken by the later timestamp, so a milestone recorded twice
 * reports the most recent time it was reached.
 */
export function progressOf(
  events: ProgressEvent[],
  now: Date = new Date(),
): JobProgress {
  let best: { milestone: Milestone; at: Date } | null = null;

  for (const event of events) {
    if (!isMilestone(event.type)) continue;
    if (
      !best ||
      RANK[event.type] > RANK[best.milestone] ||
      (RANK[event.type] === RANK[best.milestone] && event.occurredAt > best.at)
    ) {
      best = { milestone: event.type, at: event.occurredAt };
    }
  }

  if (!best) {
    return { milestone: null, at: null, fraction: 0, minutesSince: null };
  }

  return {
    milestone: best.milestone,
    at: best.at,
    fraction: (RANK[best.milestone] + 1) / MILESTONES.length,
    minutesSince: Math.max(
      0,
      Math.floor((now.getTime() - best.at.getTime()) / 60_000),
    ),
  };
}

/**
 * What to show when there are no events at all.
 *
 * Imported jobs have no event history, and a job booked and completed in the
 * same breath may only have the status. Falling back to it means the board
 * says something true rather than "not started" about a job that is finished.
 */
export function describeProgress(
  progress: JobProgress,
  status: JobStatus,
): string {
  if (progress.milestone) return MILESTONE_LABELS[progress.milestone];

  if (status === 'COMPLETED') return MILESTONE_LABELS.COMPLETED;
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'NO_SHOW') return 'No show';
  if (status === 'DRAFT') return 'Draft';
  return 'Not started';
}

/**
 * The gap, in the phrasing a dispatcher uses.
 *
 * Only worth showing past a few minutes: "At pickup, 1m" is noise on every
 * job that has just arrived, and the number people act on is the one that has
 * been sitting there a while.
 */
export function describeWaiting(minutes: number | null): string | null {
  if (minutes === null || minutes < 5) return null;
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
