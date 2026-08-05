import type { ActorType, JobEventType } from '@prisma/client';

/**
 * The job event log, and the timeline built from it.
 *
 * `jobs.status` is a cache of the latest event — the events are the record.
 * That ordering matters: the legacy system stored only a current status, so
 * "when did this driver actually arrive" was unanswerable, and wait time (which
 * is billable) could only ever be typed in by hand.
 *
 * The pure helpers here are what Phase 5 will feed from Telegram; the shape of
 * the timeline does not change when the events start arriving from a bot
 * instead of a person.
 */

export const EVENT_LABELS: Record<JobEventType, string> = {
  CREATED: 'Job created',
  ASSIGNED: 'Assigned to driver',
  ACCEPTED: 'Accepted by driver',
  DECLINED: 'Declined by driver',
  ON_WAY: 'Driver on the way',
  ARRIVED: 'Arrived at pickup',
  POB: 'Passenger on board',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Recorded as a no-show',
  EDITED: 'Details edited',
  PRICE_SET: 'Price set',
};

export interface JobEventRecord {
  id: string;
  type: JobEventType;
  actorType: ActorType;
  actorId: string | null;
  occurredAt: Date;
  metadata?: unknown;
}

export interface TimelineEntry extends JobEventRecord {
  label: string;
  /** Minutes since the previous event; null for the first. */
  minutesSincePrevious: number | null;
  /** Human phrasing of the gap, e.g. `1h 5m`. Null for the first entry. */
  sincePrevious: string | null;
}

/**
 * Order events oldest-first and annotate the gap between each.
 *
 * The gaps are the useful part: "arrived 22:14, passenger on board 23:01" is
 * 47 minutes of waiting that someone is owed money for. Sorting happens here
 * rather than being assumed from the query, because two events can share a
 * timestamp when a status change writes alongside an import.
 */
export function buildTimeline(events: JobEventRecord[]): TimelineEntry[] {
  const ordered = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );

  return ordered.map((event, index) => {
    const previous = index > 0 ? ordered[index - 1] : undefined;
    const minutes = previous
      ? Math.round(
          (event.occurredAt.getTime() - previous.occurredAt.getTime()) / 60000,
        )
      : null;

    return {
      ...event,
      label: EVENT_LABELS[event.type],
      minutesSincePrevious: minutes,
      sincePrevious: minutes === null ? null : formatDuration(minutes),
    };
  });
}

/** `75 -> "1h 15m"`, `45 -> "45m"`, `0 -> "under a minute"`. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Minutes the driver spent waiting: the gap between `ARRIVED` and `POB`.
 *
 * Returns null when either event is missing, which is the honest answer until
 * Phase 5 wires the driver's buttons. Null means "not known"; the finance
 * panel must not read that as zero and quietly drop billable time.
 *
 * The first `ARRIVED` and the first `POB` after it are used, so a driver who
 * fat-fingers the button twice does not restart the clock.
 */
export function waitMinutesFromEvents(events: JobEventRecord[]): number | null {
  const ordered = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );

  const arrived = ordered.find((event) => event.type === 'ARRIVED');
  if (!arrived) return null;

  const pob = ordered.find(
    (event) =>
      event.type === 'POB' && event.occurredAt.getTime() >= arrived.occurredAt.getTime(),
  );
  if (!pob) return null;

  const minutes = Math.round(
    (pob.occurredAt.getTime() - arrived.occurredAt.getTime()) / 60000,
  );
  return Math.max(0, minutes);
}

/** The most recent event of a given type, or null. */
export function latestEvent(
  events: JobEventRecord[],
  type: JobEventType,
): JobEventRecord | null {
  const matching = events.filter((event) => event.type === type);
  if (matching.length === 0) return null;
  return matching.reduce((latest, event) =>
    event.occurredAt.getTime() > latest.occurredAt.getTime() ? event : latest,
  );
}

export const ACTOR_LABELS: Record<ActorType, string> = {
  USER: 'Office',
  DRIVER: 'Driver',
  SYSTEM: 'System',
};
