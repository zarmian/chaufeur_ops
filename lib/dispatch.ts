import { findConflicts, occupiedBy, type ConflictCandidate } from './conflicts';
import { endOfZonedDay, formatInZone, startOfZonedDay } from './dates';
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
  estimatedMinutes: true,
  status: true,
  pickupText: true,
  dropoffText: true,
  flightNumber: true,
  passengerName: true,
  clientPricePence: true,
  zeroValueReason: true,
  driverId: true,
  vehicleId: true,
  client: { select: { name: true } },
  vehicle: { select: { registration: true } },
  finance: { select: { customerHours: true } },
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

  type JobRow = (typeof jobs)[number];

  const candidateOf = (job: JobRow): ConflictCandidate => ({
    id: job.id,
    reference: job.reference,
    scheduledAt: job.scheduledAt,
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
      unpriced: job.clientPricePence === null && !job.zeroValueReason,
      conflictsWith: conflictIds.get(job.id) ?? [],
      ...position(window.from, window.to, span),
    };
  };

  const rows: DispatchRow[] = drivers.map((driver) => ({
    driverId: driver.id,
    driverName: driver.name,
    vehicleRegistration: driver.assignedVehicle?.registration ?? null,
    telegramLinked: driver.telegramChatId !== null,
    blocks: (byDriver.get(driver.id) ?? []).map(toBlock),
  }));

  const unassigned = jobs
    .filter((job) => !job.driverId && job.scheduledAt >= from)
    .map(toBlock);

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
      jobs: jobs.filter((job) => job.scheduledAt >= from).length,
      unassigned: unassigned.length,
      conflicts: conflictIds.size,
      unpriced: jobs.filter(
        (job) =>
          job.scheduledAt >= from &&
          job.clientPricePence === null &&
          !job.zeroValueReason,
      ).length,
    },
  };
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
