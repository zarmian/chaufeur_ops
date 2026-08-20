import type { JobStatus } from '@prisma/client';
import { findConflicts, occupiedBy, type ConflictCandidate } from './conflicts';
import {
  endOfZonedDay,
  formatInZone,
  getPartsInZone,
  startOfZonedDay,
} from './dates';
import { attentionItems, type AttentionItem } from './dispatch-attention';
import { straightLineProvider } from './eta/straight-line';
import { getEtaConfig, POSITION_MAX_AGE_MINUTES } from './eta/store';
import { describeMinutes, pointFrom } from './eta/types';
import {
  describeProgress,
  describeWaiting,
  MILESTONES,
  progressOf,
  type JobProgress,
  type ProgressEvent,
} from './job-progress';
import { hasPriceOrReason } from './job-status';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import { getSettings } from './settings';

/**
 * The day, by driver — spec 6.1.
 *
 * One query for the day's jobs and one for the drivers, then everything else
 * is arithmetic. The alternative — a query per driver row — is what makes a
 * timeline take four seconds with forty drivers, and the budget here is one.
 *
 * Conflicts are computed in the same pass rather than by asking the database
 * again per block: the day's jobs are already in memory, and a clash is a
 * comparison between two of them.
 */

/** The hours the timeline spans. Outside these, jobs stack at the edges. */
export const DAY_START_HOUR = 5;
export const DAY_END_HOUR = 24;

export interface DispatchBlock {
  id: string;
  reference: string;
  scheduledAt: Date;
  endsAt: Date;
  /**
   * `14:30` in the configured zone.
   *
   * Formatted here rather than in the browser, because the client has no
   * business knowing the operator's timezone and slicing a UTC ISO string
   * would show every British Summer Time pickup an hour early — which is the
   * exact defect the UTC-storage rule exists to prevent.
   */
  startLabel: string;
  endLabel: string;
  minutes: number;
  status: string;
  pickupText: string;
  dropoffText: string;
  clientName: string | null;
  passengerName: string | null;
  vehicleRegistration: string | null;
  flightNumber: string | null;
  unpriced: boolean;
  /** Ids of the jobs this one clashes with, for the red outline. */
  conflictsWith: string[];
  /** Where the block sits, as a percentage of the timeline's width. */
  leftPct: number;
  widthPct: number;
}

export interface DispatchRow {
  driverId: string;
  driverName: string;
  vehicleRegistration: string | null;
  telegramLinked: boolean;
  /**
   * When this driver's phone last reported a position, and how far that puts
   * them from the pickup of whatever they are on. Both null unless location
   * sharing is on and they are mid-job.
   *
   * Estimated locally, never through the routing provider. The board reloads
   * every thirty seconds, so a paid call per driver per refresh would be a
   * bill per driver per half-minute all day. The message a client actually
   * receives is worth a routing call; a number an operator glances at is not.
   */
  lastSeenAt: Date | null;
  etaPhrase: string | null;
  blocks: DispatchBlock[];
}

export interface DispatchDay {
  /** Local midnight, as an instant. */
  from: Date;
  to: Date;
  timeZone: string;
  rows: DispatchRow[];
  /** Jobs with nobody on them, by pickup time — spec 6.1.5. */
  unassigned: DispatchBlock[];
  /** Where "now" sits on the timeline, or null when the day is not today. */
  nowPct: number | null;
  hours: number[];
  counts: {
    jobs: number;
    unassigned: number;
    conflicts: number;
    unpriced: number;
  };
}

const JOB_SELECT = {
  id: true,
  reference: true,
  scheduledAt: true,
  jobType: true,
  estimatedMinutes: true,
  status: true,
  pickupText: true,
  dropoffText: true,
  // For the distance from a driver's last position. Null on a pickup typed
  // by hand, which is why the ETA is optional everywhere downstream.
  pickupLat: true,
  pickupLng: true,
  flightNumber: true,
  passengerName: true,
  clientPricePence: true,
  zeroValueReason: true,
  driverId: true,
  vehicleId: true,
  client: { select: { name: true } },
  vehicle: { select: { registration: true } },
  finance: { select: { customerHours: true, totalClientPence: true } },
} as const;

export async function loadDispatchDay(
  day: Date,
  options: { now?: Date; includeEmptyDrivers?: boolean } = {},
): Promise<DispatchDay> {
  const [{ timeZone }, settings] = await Promise.all([
    getLocaleConfig(),
    getSettings(),
  ]);

  const from = startOfZonedDay(day, timeZone);
  const to = endOfZonedDay(day, timeZone);
  const now = options.now ?? new Date();

  // Widened backwards so an overnight job that began yesterday and is still
  // running shows on today's board rather than vanishing.
  const [jobs, drivers] = await Promise.all([
    prisma.job.findMany({
      where: {
        scheduledAt: {
          gte: new Date(from.getTime() - 12 * 60 * 60 * 1000),
          lte: to,
        },
        status: { notIn: ['CANCELLED'] },
      },
      select: JOB_SELECT,
      orderBy: { scheduledAt: 'asc' },
      take: 1000,
    }),
    prisma.driver.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        telegramChatId: true,
        assignedVehicle: { select: { registration: true } },
      },
      orderBy: { name: 'asc' },
      take: 400,
    }),
  ]);

  // One query for the whole board rather than one per driver. Only positions
  // recent enough to mean anything are fetched at all.
  const positions = await prisma.driverPosition.findMany({
    where: {
      driverId: { in: drivers.map((driver) => driver.id) },
      recordedAt: { gte: new Date(now.getTime() - POSITION_MAX_AGE_MINUTES * 60_000) },
    },
    orderBy: { recordedAt: 'desc' },
    select: { driverId: true, jobId: true, lat: true, lng: true, recordedAt: true },
    take: 2000,
  });

  const latestPosition = new Map<string, (typeof positions)[number]>();
  for (const row of positions) {
    if (!latestPosition.has(row.driverId)) latestPosition.set(row.driverId, row);
  }

  type JobRow = (typeof jobs)[number];

  const candidateOf = (job: JobRow): ConflictCandidate => ({
    id: job.id,
    reference: job.reference,
    scheduledAt: job.scheduledAt,
    isContract: job.jobType === 'CONTRACT',
    estimatedMinutes: job.estimatedMinutes,
    customerHours: job.finance?.customerHours
      ? Number(job.finance.customerHours)
      : null,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    status: job.status,
    driverId: job.driverId,
    vehicleId: job.vehicleId,
  });

  // Grouped once, so the conflict pass is per driver rather than per job.
  const byDriver = new Map<string, JobRow[]>();
  for (const job of jobs) {
    if (!job.driverId) continue;
    const list = byDriver.get(job.driverId);
    if (list) list.push(job);
    else byDriver.set(job.driverId, [job]);
  }

  const conflictIds = new Map<string, string[]>();
  for (const list of byDriver.values()) {
    const candidates = list.map(candidateOf);
    for (const job of list) {
      const found = findConflicts(
        candidateOf(job),
        candidates,
        settings.driverConflictBufferMinutes,
      )
        // Only genuine overlaps get the red outline. A tight-but-workable gap
        // outlined in red on every second block is a board nobody reads.
        .filter((conflict) => conflict.overlapping)
        .map((conflict) => conflict.id);

      if (found.length > 0) conflictIds.set(job.id, found);
    }
  }

  const span = spanFor(from, timeZone);
  const clock = (instant: Date) =>
    formatInZone(instant, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });

  const toBlock = (job: JobRow): DispatchBlock => {
    const window = occupiedBy(candidateOf(job));
    const minutes = Math.round(
      (window.to.getTime() - window.from.getTime()) / 60_000,
    );

    return {
      id: job.id,
      reference: job.reference,
      scheduledAt: job.scheduledAt,
      endsAt: window.to,
      startLabel: clock(window.from),
      endLabel: clock(window.to),
      minutes,
      status: job.status,
      pickupText: job.pickupText,
      dropoffText: job.dropoffText,
      clientName: job.client?.name ?? null,
      passengerName: job.passengerName,
      vehicleRegistration: job.vehicle?.registration ?? null,
      flightNumber: job.flightNumber,
      // Through the shared helper, so an as-directed job priced by the hour
      // is not flagged on the board as though nobody had quoted it.
      unpriced: !hasPriceOrReason(job),
      conflictsWith: conflictIds.get(job.id) ?? [],
      ...position(window.from, window.to, span),
    };
  };

  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const localEta = straightLineProvider({ kmh: (await getEtaConfig()).assumedKmh });

  const rows: DispatchRow[] = await Promise.all(
    drivers.map(async (driver) => {
      const seen = latestPosition.get(driver.id);
      const pickup = seen?.jobId
        ? pointFrom(
            jobsById.get(seen.jobId)?.pickupLat,
            jobsById.get(seen.jobId)?.pickupLng,
          )
        : null;
      const origin = seen ? pointFrom(seen.lat, seen.lng) : null;

      const estimate =
        origin && pickup ? await localEta.estimate(origin, pickup) : null;

      return {
        driverId: driver.id,
        driverName: driver.name,
        vehicleRegistration: driver.assignedVehicle?.registration ?? null,
        telegramLinked: driver.telegramChatId !== null,
        lastSeenAt: seen?.recordedAt ?? null,
        etaPhrase: estimate ? describeMinutes(estimate.minutes) : null,
        blocks: (byDriver.get(driver.id) ?? []).map(toBlock),
      };
    }),
  );

  const onToday = (job: JobRow) => job.scheduledAt >= from;

  const unassigned = jobs.filter((job) => !job.driverId && onToday(job)).map(toBlock);

  return {
    from,
    to,
    timeZone,
    rows: options.includeEmptyDrivers
      ? rows
      : rows.filter((row) => row.blocks.length > 0),
    unassigned,
    nowPct:
      now >= span.from && now <= span.to
        ? ((now.getTime() - span.from.getTime()) / span.width) * 100
        : null,
    hours: Array.from(
      { length: DAY_END_HOUR - DAY_START_HOUR },
      (_, i) => DAY_START_HOUR + i,
    ),
    counts: {
      jobs: jobs.filter(onToday).length,
      unassigned: unassigned.length,
      conflicts: conflictIds.size,
      unpriced: jobs.filter(
        (job) => onToday(job) && !hasPriceOrReason(job),
      ).length,
    },
  };
}

// ------------------------------------------------------------ the range view

export interface RangeJob extends DispatchBlock {
  driverId: string | null;
  driverName: string | null;
  jobType: string;
  /** `YYYY-MM-DD` in the configured zone — which day's section this belongs to. */
  day: string;
  /** How far the driver has actually got, from the events. */
  progress: JobProgress;
  progressLabel: string;
  waitingFor: string | null;
}

export interface DispatchDaySummary {
  /** `YYYY-MM-DD`, the key the sections and the rail agree on. */
  date: string;
  /** "Today", "Tomorrow", or "Fri 22 Aug". */
  label: string;
  weekday: string;
  jobs: RangeJob[];
  counts: {
    jobs: number;
    unassigned: number;
    unpriced: number;
    conflicts: number;
  };
}

export interface DispatchRange {
  timeZone: string;
  days: DispatchDaySummary[];
  /** Everything wanting somebody, across the whole range, worst first. */
  attention: (AttentionItem & {
    job: RangeJob;
    /** "40m ago", "in 2h" — phrased here, where the zone is known. */
    when: string;
  })[];
  drivers: { id: string; name: string; vehicleRegistration: string | null }[];
  totals: { jobs: number; unassigned: number; unpriced: number; conflicts: number };
}

/**
 * Several days of work, and what is wrong with it.
 *
 * The board this replaces showed one day as a Gantt chart, which answered
 * "who is busy when" and nothing else — a ninety-minute block on a
 * nineteen-hour axis has room for a start time and a truncated pickup, and
 * tomorrow was a click away.
 *
 * Three queries for the whole range rather than three per day: the jobs, the
 * drivers, and the milestone events. Everything after that is arithmetic on
 * what is already in memory, which is the same budget `loadDispatchDay` works
 * to — a query per day, times four, is how a board that took one second takes
 * four.
 */
export async function loadDispatchRange(
  start: Date,
  options: { days?: number; now?: Date } = {},
): Promise<DispatchRange> {
  const [{ timeZone, locale }, settings] = await Promise.all([
    getLocaleConfig(),
    getSettings(),
  ]);

  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(14, options.days ?? settings.dispatchDaysAhead));

  const from = startOfZonedDay(start, timeZone);
  const to = endOfZonedDay(addDays(start, days - 1), timeZone);

  const [jobs, drivers] = await Promise.all([
    prisma.job.findMany({
      where: {
        // Widened backwards for the same reason the day view is: an overnight
        // job that began yesterday and is still running is exactly the kind
        // of thing this board exists to surface.
        scheduledAt: {
          gte: new Date(from.getTime() - 12 * 60 * 60 * 1000),
          lte: to,
        },
        status: { notIn: ['CANCELLED'] },
      },
      select: { ...JOB_SELECT, driver: { select: { name: true } } },
      orderBy: { scheduledAt: 'asc' },
      take: 2000,
    }),
    prisma.driver.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        assignedVehicle: { select: { registration: true } },
      },
      orderBy: { name: 'asc' },
      take: 400,
    }),
  ]);

  /*
   * The milestone events for every job on the board, in one query.
   *
   * This is what lets the board distinguish a driver who has not looked at
   * their phone from one who is five minutes from the pickup — both of which
   * read `ASSIGNED` in the status column. Filtered to the six milestones
   * because a busy job accumulates edits and price changes that say nothing
   * about where the car is.
   */
  const milestoneEvents =
    jobs.length === 0
      ? []
      : await prisma.jobEvent.findMany({
          where: {
            jobId: { in: jobs.map((job) => job.id) },
            type: { in: [...MILESTONES] },
          },
          select: { jobId: true, type: true, occurredAt: true },
          orderBy: { occurredAt: 'asc' },
          take: 10_000,
        });

  const eventsByJob = new Map<string, ProgressEvent[]>();
  for (const event of milestoneEvents) {
    const list = eventsByJob.get(event.jobId);
    if (list) list.push(event);
    else eventsByJob.set(event.jobId, [event]);
  }

  type JobRow = (typeof jobs)[number];

  const candidateOf = (job: JobRow): ConflictCandidate => ({
    id: job.id,
    reference: job.reference,
    scheduledAt: job.scheduledAt,
    isContract: job.jobType === 'CONTRACT',
    estimatedMinutes: job.estimatedMinutes,
    customerHours: job.finance?.customerHours
      ? Number(job.finance.customerHours)
      : null,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    status: job.status,
    driverId: job.driverId,
    vehicleId: job.vehicleId,
  });

  // Clashes, per driver, over the whole range. Grouped once so the pass is
  // per driver rather than per job.
  const byDriver = new Map<string, JobRow[]>();
  for (const job of jobs) {
    if (!job.driverId) continue;
    const list = byDriver.get(job.driverId);
    if (list) list.push(job);
    else byDriver.set(job.driverId, [job]);
  }

  const conflictIds = new Map<string, string[]>();
  for (const list of byDriver.values()) {
    const candidates = list.map(candidateOf);
    for (const job of list) {
      const found = findConflicts(
        candidateOf(job),
        candidates,
        settings.driverConflictBufferMinutes,
      )
        .filter((conflict) => conflict.overlapping)
        .map((conflict) => conflict.id);
      if (found.length > 0) conflictIds.set(job.id, found);
    }
  }

  const clock = (instant: Date) =>
    formatInZone(instant, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });

  const toRangeJob = (job: JobRow): RangeJob => {
    const window = occupiedBy(candidateOf(job));
    const progress = progressOf(eventsByJob.get(job.id) ?? [], now);

    return {
      id: job.id,
      reference: job.reference,
      scheduledAt: job.scheduledAt,
      endsAt: window.to,
      startLabel: clock(window.from),
      endLabel: clock(window.to),
      minutes: Math.round((window.to.getTime() - window.from.getTime()) / 60_000),
      status: job.status,
      pickupText: job.pickupText,
      dropoffText: job.dropoffText,
      clientName: job.client?.name ?? null,
      passengerName: job.passengerName,
      vehicleRegistration: job.vehicle?.registration ?? null,
      flightNumber: job.flightNumber,
      unpriced: !hasPriceOrReason(job),
      conflictsWith: conflictIds.get(job.id) ?? [],
      // The range view lists jobs rather than positioning them on an axis, so
      // the percentages are zero — kept in the shape so a block and a row can
      // share a type.
      leftPct: 0,
      widthPct: 0,
      driverId: job.driverId,
      driverName: job.driver?.name ?? null,
      jobType: job.jobType,
      day: dayKeyOf(job.scheduledAt, timeZone),
      progress,
      progressLabel: describeProgress(progress, job.status as JobStatus),
      waitingFor: describeWaiting(progress.minutesSince),
    };
  };

  const rangeJobs = jobs.map(toRangeJob);
  const byId = new Map(rangeJobs.map((job) => [job.id, job]));

  // Bucketed by local day. Every day in the range gets a section, including
  // the empty ones — "nothing booked on Sunday" is an answer, and a missing
  // section is a question.
  const sections: DispatchDaySummary[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(start, offset);
    const key = dayKeyOf(startOfZonedDay(date, timeZone), timeZone);
    const forDay = rangeJobs.filter((job) => job.day === key);

    sections.push({
      date: key,
      label: relativeDayLabel(key, now, timeZone, locale),
      weekday: formatInZone(startOfZonedDay(date, timeZone), {
        timeZone,
        weekday: 'short',
        locale,
      }),
      jobs: forDay,
      counts: {
        jobs: forDay.length,
        unassigned: forDay.filter((job) => !job.driverId).length,
        unpriced: forDay.filter((job) => job.unpriced).length,
        conflicts: forDay.filter((job) => job.conflictsWith.length > 0).length,
      },
    });
  }

  const items = attentionItems(
    jobs.map((job) => ({
      id: job.id,
      reference: job.reference,
      status: job.status,
      driverId: job.driverId,
      scheduledAt: job.scheduledAt,
      estimatedMinutes: job.estimatedMinutes,
      customerHours: job.finance?.customerHours
        ? Number(job.finance.customerHours)
        : null,
      events: eventsByJob.get(job.id) ?? [],
    })),
    now,
    {
      unassignedHours: settings.dispatchUnassignedHours,
      lateMinutes: settings.dispatchLateMinutes,
    },
  );

  return {
    timeZone,
    days: sections,
    attention: items.flatMap((item) => {
      const job = byId.get(item.jobId);
      return job ? [{ ...item, job, when: describeGap(item.minutes) }] : [];
    }),
    drivers: drivers.map((driver) => ({
      id: driver.id,
      name: driver.name,
      vehicleRegistration: driver.assignedVehicle?.registration ?? null,
    })),
    totals: {
      jobs: rangeJobs.length,
      unassigned: rangeJobs.filter((job) => !job.driverId).length,
      unpriced: rangeJobs.filter((job) => job.unpriced).length,
      conflicts: rangeJobs.filter((job) => job.conflictsWith.length > 0).length,
    },
  };
}

/** Midday-anchored, so adding days never lands on a missing hour. */
function addDays(from: Date, days: number): Date {
  const date = new Date(from);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/**
 * `YYYY-MM-DD` as the configured zone sees the instant.
 *
 * Through `getPartsInZone` rather than by formatting and slicing. A formatted
 * date's field order is the *locale's*, not the format's: `en-GB` gives
 * 21/08/2026 and `en-US` gives 08/21/2026, so anything that pulls the pieces
 * out by position is correct in Britain and silently swaps day for month
 * everywhere else. Locale is configuration here, so that is a bug waiting for
 * the first install that changes it.
 */
function dayKeyOf(instant: Date, timeZone: string): string {
  const { year, month, day } = getPartsInZone(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * "Today", "Tomorrow", or the date.
 *
 * The first two are what people actually say, and on a board whose whole point
 * is the next few days, "Fri 21 Aug" for today makes the reader do arithmetic
 * to find out whether it is the one they are standing in.
 */
function relativeDayLabel(
  key: string,
  now: Date,
  timeZone: string,
  locale: string,
): string {
  const today = dayKeyOf(now, timeZone);
  if (key === today) return 'Today';
  if (key === dayKeyOf(addDays(now, 1), timeZone)) return 'Tomorrow';

  return formatInZone(new Date(`${key}T12:00:00.000Z`), {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    locale,
  });
}

/** Minutes either side of an instant, in words. Negative is still to come. */
function describeGap(minutes: number): string {
  const size = Math.abs(minutes);
  const phrase =
    size < 60
      ? `${size}m`
      : size % 60 === 0
        ? `${Math.floor(size / 60)}h`
        : `${Math.floor(size / 60)}h ${size % 60}m`;

  if (minutes === 0) return 'now';
  return minutes > 0 ? `${phrase} ago` : `in ${phrase}`;
}

interface Span {
  from: Date;
  to: Date;
  width: number;
}

/** The instants the timeline's left and right edges correspond to. */
function spanFor(midnight: Date, _timeZone: string): Span {
  const from = new Date(midnight.getTime() + DAY_START_HOUR * 60 * 60 * 1000);
  const to = new Date(midnight.getTime() + DAY_END_HOUR * 60 * 60 * 1000);
  return { from, to, width: to.getTime() - from.getTime() };
}

/**
 * Where a block sits, as percentages.
 *
 * Clamped to the timeline rather than allowed to run off it: a 03:00 airport
 * run on a board that starts at 05:00 would otherwise be positioned at minus
 * eight percent and disappear. Squashed against the left edge is wrong-ish
 * and visible; off-screen is wrong and invisible.
 */
function position(
  from: Date,
  to: Date,
  span: Span,
): { leftPct: number; widthPct: number } {
  const start = Math.max(span.from.getTime(), Math.min(from.getTime(), span.to.getTime()));
  const end = Math.max(start, Math.min(to.getTime(), span.to.getTime()));

  const leftPct = ((start - span.from.getTime()) / span.width) * 100;
  // A floor, so a five-minute job is still clickable.
  const widthPct = Math.max(1.2, ((end - start) / span.width) * 100);

  return {
    leftPct: Math.min(leftPct, 98.8),
    widthPct: Math.min(widthPct, 100 - Math.min(leftPct, 98.8)),
  };
}

/** Status to a CSS class. No hex literals — spec's white-label rule. */
export const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  PENDING: 'bg-muted text-muted-foreground',
  ASSIGNED: 'bg-primary/70 text-primary-foreground',
  ACCEPTED: 'bg-warning/80 text-warning-foreground',
  IN_PROGRESS: 'bg-success/80 text-success-foreground',
  COMPLETED: 'bg-success text-success-foreground',
  CANCELLED: 'bg-destructive/70 text-destructive-foreground',
  NO_SHOW: 'bg-destructive text-destructive-foreground',
};
