import {
  describeConflict,
  findConflicts,
  occupiedBy,
  type Conflict,
  type ConflictCandidate,
} from './conflicts';
import { endOfZonedDay, startOfZonedDay } from './dates';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import { getSettings } from './settings';

/**
 * Loading the jobs a proposed one might clash with — spec 6.2.
 *
 * The arithmetic is in `conflicts.ts` and pure. What lives here is the query,
 * and the one thing that query has to get right: it must fetch a *window*
 * wide enough that a long job starting well before the proposed one is still
 * a candidate.
 *
 * Fetching only jobs near the proposed pickup would miss exactly the case the
 * interval arithmetic exists to catch — a four-hour hire that started three
 * hours ago and has not finished.
 */

/** How far back to look for something still running. Generous on purpose. */
const LOOKBACK_HOURS = 14;

const CANDIDATE_SELECT = {
  id: true,
  reference: true,
  scheduledAt: true,
  jobType: true,
  estimatedMinutes: true,
  pickupText: true,
  dropoffText: true,
  status: true,
  driverId: true,
  vehicleId: true,
  finance: { select: { customerHours: true } },
} as const;

type Row = {
  id: string;
  reference: string;
  scheduledAt: Date;
  jobType: string;
  estimatedMinutes: number | null;
  pickupText: string;
  dropoffText: string;
  status: string;
  driverId: string | null;
  vehicleId: string | null;
  finance: { customerHours: unknown } | null;
};

function toCandidate(row: Row): ConflictCandidate {
  return {
    id: row.id,
    reference: row.reference,
    scheduledAt: row.scheduledAt,
    isContract: row.jobType === 'CONTRACT',
    estimatedMinutes: row.estimatedMinutes,
    // Prisma hands a Decimal back; Number is exact enough for hours.
    customerHours: row.finance?.customerHours
      ? Number(row.finance.customerHours)
      : null,
    pickupText: row.pickupText,
    dropoffText: row.dropoffText,
    status: row.status,
    driverId: row.driverId,
    vehicleId: row.vehicleId,
  };
}

export interface ConflictCheck {
  conflicts: Conflict[];
  /** The sentence an operator reads, or null when there is nothing to say. */
  warning: string | null;
  bufferMinutes: number;
}

const NOTHING: ConflictCheck = { conflicts: [], warning: null, bufferMinutes: 0 };

/**
 * What else this driver is doing around then.
 *
 * Cancelled, completed and no-show jobs are excluded: a job that already
 * happened cannot clash with one being booked, and warning about it would
 * train people to dismiss the warning.
 */
export async function checkDriverConflicts(
  driverId: string | null,
  proposed: {
    id?: string;
    scheduledAt: Date;
    estimatedMinutes?: number | null;
    customerHours?: number | null;
    isContract?: boolean | null;
  },
  bufferMinutes?: number,
): Promise<ConflictCheck> {
  if (!driverId) return NOTHING;

  const buffer = bufferMinutes ?? (await getSettings()).driverConflictBufferMinutes;
  const rows = await candidatesAround(proposed.scheduledAt, buffer, { driverId });

  const conflicts = findConflicts(
    { id: proposed.id ?? '', ...proposed },
    rows.map(toCandidate),
    buffer,
  );

  return {
    conflicts,
    warning: conflicts[0] ? describeConflict(conflicts[0], 'driver') : null,
    bufferMinutes: buffer,
  };
}

/** The same question for the car — spec 6.2.5. */
export async function checkVehicleConflicts(
  vehicleId: string | null,
  proposed: {
    id?: string;
    scheduledAt: Date;
    estimatedMinutes?: number | null;
    customerHours?: number | null;
    isContract?: boolean | null;
  },
  bufferMinutes?: number,
): Promise<ConflictCheck> {
  if (!vehicleId) return NOTHING;

  const buffer = bufferMinutes ?? (await getSettings()).driverConflictBufferMinutes;
  const rows = await candidatesAround(proposed.scheduledAt, buffer, { vehicleId });

  const conflicts = findConflicts(
    { id: proposed.id ?? '', ...proposed },
    rows.map(toCandidate),
    buffer,
  );

  return {
    conflicts,
    warning: conflicts[0] ? describeConflict(conflicts[0], 'vehicle') : null,
    bufferMinutes: buffer,
  };
}

async function candidatesAround(
  scheduledAt: Date,
  bufferMinutes: number,
  who: { driverId?: string; vehicleId?: string },
): Promise<Row[]> {
  // Back far enough to catch something long that is still running, forward
  // only as far as the buffer can reach.
  const from = new Date(scheduledAt.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const to = new Date(scheduledAt.getTime() + (bufferMinutes + 12 * 60) * 60_000);

  return prisma.job.findMany({
    where: {
      ...who,
      status: { notIn: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] },
      scheduledAt: { gte: from, lte: to },
    },
    select: CANDIDATE_SELECT,
    orderBy: { scheduledAt: 'asc' },
    take: 50,
  }) as unknown as Promise<Row[]>;
}

export interface ConflictDigestEntry {
  subject: 'driver' | 'vehicle';
  who: string;
  reference: string;
  otherReference: string;
  scheduledAt: Date;
  overlapping: boolean;
  gapMinutes: number;
}

/**
 * Tomorrow's clashes, for the daily digest — spec 6.2.7.
 *
 * Each pair is reported once. Without that, every clash appears twice — once
 * from each job's point of view — and a digest that double-counts is a digest
 * whose numbers nobody trusts.
 */
export async function conflictsForDay(
  day: Date,
  bufferMinutes?: number,
): Promise<ConflictDigestEntry[]> {
  const buffer = bufferMinutes ?? (await getSettings()).driverConflictBufferMinutes;
  const { timeZone } = await getLocaleConfig();

  const from = startOfZonedDay(day, timeZone);
  const to = endOfZonedDay(day, timeZone);

  // Widened backwards so a job that started the previous evening and runs
  // into the day is still considered.
  const rows = (await prisma.job.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] },
      scheduledAt: {
        gte: new Date(from.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000),
        lte: to,
      },
      OR: [{ driverId: { not: null } }, { vehicleId: { not: null } }],
    },
    select: {
      ...CANDIDATE_SELECT,
      driver: { select: { name: true } },
      vehicle: { select: { registration: true } },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 500,
  })) as unknown as Array<Row & {
    driver: { name: string } | null;
    vehicle: { registration: string } | null;
  }>;

  const entries: ConflictDigestEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    // Only jobs actually in the day are reported; the earlier ones are there
    // to be clashed *with*.
    if (row.scheduledAt < from) continue;

    for (const subject of ['driver', 'vehicle'] as const) {
      const id = subject === 'driver' ? row.driverId : row.vehicleId;
      if (!id) continue;

      const peers = rows.filter((other) =>
        subject === 'driver' ? other.driverId === id : other.vehicleId === id,
      );

      for (const conflict of findConflicts(toCandidate(row), peers.map(toCandidate), buffer)) {
        // One entry per pair per subject, whichever side is seen first.
        const key = [subject, ...[row.id, conflict.id].sort()].join(':');
        if (seen.has(key)) continue;
        seen.add(key);

        entries.push({
          subject,
          who:
            subject === 'driver'
              ? (row.driver?.name ?? 'Unknown driver')
              : (row.vehicle?.registration ?? 'Unknown vehicle'),
          reference: row.reference,
          otherReference: conflict.reference,
          scheduledAt: row.scheduledAt,
          overlapping: conflict.overlapping,
          gapMinutes: conflict.gapMinutes,
        });
      }
    }
  }

  // Genuine overlaps first: they are the ones somebody has to act on today.
  return entries.sort(
    (a, b) => Number(b.overlapping) - Number(a.overlapping) || a.gapMinutes - b.gapMinutes,
  );
}

export { occupiedBy };
