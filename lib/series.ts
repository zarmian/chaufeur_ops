import type { Prisma, RecurrenceFrequency } from '@prisma/client';
import { z } from 'zod';
import type { AuditContext } from './audit';
import { withAudit } from './audit';
import { toLondon, toUTC } from './dates';
import { createJob, duplicateDefaults, updateJob, type JobInput } from './jobs';
import { prisma } from './prisma';
import {
  describeRule,
  expandRecurrence,
  MAX_OCCURRENCES,
  RecurrenceError,
  suggestReturnAt,
  type RecurrenceRule,
} from './recurrence';

/**
 * Recurring and linked jobs — spec 6.3.
 *
 * The rule this module is built around: **generation creates independent
 * jobs** (6.3.4). The series holds the recurrence and nothing else. It never
 * rewrites a job it produced, because by the time anybody edits a series
 * some of its jobs have drivers assigned, prices agreed and events recorded,
 * and a series that reached back into them would be quietly undoing work
 * somebody did on purpose.
 *
 * What the series gives instead is the ability to *find* them together. That
 * is what makes "this and future" possible, and it is why every group
 * operation here resolves to a list of job ids and then acts on each one
 * through the ordinary job path — so each is validated and audited
 * individually, exactly as if an operator had opened it.
 */

export const recurrenceSchema = z
  .object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    interval: z.coerce.number().int().min(1).max(52).default(1),
    weekdays: z.array(z.coerce.number().int().min(0).max(6)).default([]),
    /** Exactly one of these two. */
    occurrences: z.coerce.number().int().min(1).max(MAX_OCCURRENCES).nullable().default(null),
    endsOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
      .nullable()
      .default(null),
  })
  .refine(
    (value) => (value.occurrences === null) !== (value.endsOn === null),
    {
      message: 'Give either an end date or a number of occurrences, not both',
      path: ['endsOn'],
    },
  );

export type RecurrenceInput = z.infer<typeof recurrenceSchema>;

/** How far a group operation reaches — spec 6.3.5 and 6.3.6. */
export type SeriesScope = 'this' | 'future' | 'all';

export interface GeneratedSeries {
  seriesId: string;
  jobIds: string[];
  /** Occurrences the rule produced but that were not booked, and why. */
  skipped: Array<{ at: Date; reason: string }>;
}

/**
 * Book a recurring series — spec 6.3.3 and 6.3.4.
 *
 * The series row and the first job go in together; the rest follow one at a
 * time through `createJob`, so each gets its own reference, its own `CREATED`
 * event and its own audit entry. Sequential rather than parallel because
 * reference allocation is a counter and there is nothing to win by racing it.
 *
 * A failure part-way leaves the jobs already booked in place rather than
 * rolling them back. That is deliberate: they are real bookings, the client
 * has been told about them, and the honest report is "eleven of twelve, and
 * here is the one that failed".
 */
export async function createSeries(
  base: JobInput,
  recurrence: RecurrenceInput,
  context: AuditContext,
  timeZone: string,
): Promise<GeneratedSeries> {
  const rule = toRule(base, recurrence, timeZone);
  const occurrences = expandRecurrence(rule, timeZone);

  if (occurrences.length === 0) {
    throw new RecurrenceError('That recurrence produces no jobs');
  }

  const label = labelFor(base, rule, timeZone);

  const series = await withAudit(
    'JobSeries',
    'create',
    async (tx) => {
      const created = await tx.jobSeries.create({
        data: {
          frequency: recurrence.frequency as RecurrenceFrequency,
          interval: recurrence.interval,
          weekdays: rule.weekdays ?? [],
          startsAt: occurrences[0]!,
          occurrences: recurrence.occurrences,
          endsOn: recurrence.endsOn ? new Date(recurrence.endsOn) : null,
          label,
          createdById: context.userId ?? null,
        },
      });
      return { entityId: created.id, after: created, result: created };
    },
    context,
  );

  const jobIds: string[] = [];
  const skipped: GeneratedSeries['skipped'] = [];

  for (const [index, at] of occurrences.entries()) {
    const local = toLondon(at, timeZone);
    const [date, time] = local.split('T');

    try {
      const job = await createJob(
        { ...base, scheduledDate: date!, scheduledTime: time! },
        context,
        timeZone,
      );
      // Stamped after creation rather than passed through `createJob`, which
      // is the ordinary booking path and has no business knowing about
      // series. The job is complete and valid without these two columns.
      await prisma.job.update({
        where: { id: job.id },
        data: { seriesId: series.id, seriesIndex: index + 1 },
      });
      jobIds.push(job.id);
    } catch (error) {
      skipped.push({
        at,
        reason: error instanceof Error ? error.message : 'Could not be booked',
      });
    }
  }

  return { seriesId: series.id, jobIds, skipped };
}

function toRule(
  base: JobInput,
  recurrence: RecurrenceInput,
  timeZone: string,
): RecurrenceRule {
  return {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    weekdays: recurrence.weekdays,
    startsAt: scheduledAtOf(base, timeZone),
    count: recurrence.occurrences,
    until: recurrence.endsOn ? endOfDayIn(recurrence.endsOn, timeZone) : null,
  };
}

function scheduledAtOf(base: JobInput, timeZone: string): Date {
  // Same conversion the ordinary booking path uses, so a series starts on
  // exactly the instant a one-off booked with the same form would.
  return toUTC(`${base.scheduledDate}T${base.scheduledTime}`, timeZone);
}

/**
 * Midday on the end date, in the operator's zone.
 *
 * Only the calendar date is read from this by `expandRecurrence`, and midday
 * is the reading that lands on the intended day in every timezone — midnight
 * is the one that slips to the previous day west of UTC.
 */
function endOfDayIn(day: string, timeZone: string): Date {
  return toUTC(`${day}T12:00`, timeZone);
}

/**
 * What the series list shows — the route, which is what somebody recognises.
 *
 * Snapshotted rather than derived from a job on read, so the list stays
 * readable after individual jobs have been edited or cancelled.
 */
function labelFor(base: JobInput, rule: RecurrenceRule, timeZone: string): string {
  const route = `${base.pickupText} → ${base.dropoffText}`;
  return `${route} · ${describeRule(rule, timeZone)}`;
}

// ------------------------------------------------------------------- scope

/**
 * The jobs a group operation touches — spec 6.3.5 and 6.3.6.
 *
 * "This and future" is resolved on the date, not on `seriesIndex`. An
 * operator who moved one occurrence to a different week means the date they
 * moved it to; an index would reach back and change a job that now sits in
 * the past.
 *
 * Only jobs that can still be changed are returned. A `COMPLETED` job is
 * history, and "cancel this and future" must not attempt to rewrite it.
 */
export async function jobsInScope(
  seriesId: string,
  fromJobId: string,
  scope: SeriesScope,
): Promise<Array<{ id: string; reference: string; scheduledAt: Date; status: string }>> {
  const anchor = await prisma.job.findUnique({
    where: { id: fromJobId },
    select: { id: true, seriesId: true, scheduledAt: true },
  });

  if (!anchor || anchor.seriesId !== seriesId) return [];

  if (scope === 'this') {
    const one = await prisma.job.findUnique({
      where: { id: fromJobId },
      select: { id: true, reference: true, scheduledAt: true, status: true },
    });
    return one ? [one] : [];
  }

  const where: Prisma.JobWhereInput = {
    seriesId,
    ...(scope === 'future' ? { scheduledAt: { gte: anchor.scheduledAt } } : {}),
    status: { notIn: ['COMPLETED', 'CANCELLED'] },
  };

  return prisma.job.findMany({
    where,
    select: { id: true, reference: true, scheduledAt: true, status: true },
    orderBy: { scheduledAt: 'asc' },
  });
}

export interface SeriesEditResult {
  changed: string[];
  refused: Array<{ reference: string; reason: string }>;
}

/**
 * Apply one edit to a job and, optionally, the ones after it — spec 6.3.5.
 *
 * **The date and time are never propagated.** Everything else about a series
 * is shared; the date is the one thing each occurrence has of its own, and
 * writing one job's date over the rest would collapse the whole series onto a
 * single day. So the anchor job takes the form as submitted, and the others
 * take every field except when they happen.
 *
 * Each job goes through `updateJob`, so each is validated against its own
 * state and audited individually. A job the update refuses is reported by
 * reference rather than skipped: "nine of twelve changed" without saying
 * which three did not is a report nobody can act on.
 */
export async function applySeriesEdit(
  anchorJobId: string,
  input: JobInput,
  scope: SeriesScope,
  context: AuditContext,
  timeZone: string,
): Promise<SeriesEditResult> {
  const anchor = await prisma.job.findUnique({
    where: { id: anchorJobId },
    select: { seriesId: true },
  });

  // **Resolve the scope before touching the anchor.** The edit may move the
  // anchor's date, and `jobsInScope` reads that date to decide what "future"
  // means — so doing it the other way round makes moving a job earlier
  // silently widen the change to occurrences the operator never selected.
  // "This and future" means the ones after where it *was*.
  const others =
    scope === 'this' || !anchor?.seriesId
      ? []
      : (await jobsInScope(anchor.seriesId, anchorJobId, scope)).filter(
          (job) => job.id !== anchorJobId,
        );

  // The anchor takes the edit exactly as submitted, date included.
  await updateJob(anchorJobId, input, context, timeZone);

  if (others.length === 0) {
    return { changed: [anchorJobId], refused: [] };
  }

  const changed = [anchorJobId];
  const refused: SeriesEditResult['refused'] = [];

  for (const job of others) {
    const local = toLondon(job.scheduledAt, timeZone);
    const [date, time] = local.split('T');

    try {
      await updateJob(
        job.id,
        { ...input, scheduledDate: date!, scheduledTime: time! },
        context,
        timeZone,
      );
      changed.push(job.id);
    } catch (error) {
      refused.push({
        reference: job.reference,
        reason: error instanceof Error ? error.message : 'Could not be changed',
      });
    }
  }

  return { changed, refused };
}

// -------------------------------------------------------------- the series view

export interface SeriesSummary {
  id: string;
  label: string;
  startsAt: Date;
  cancelledAt: Date | null;
  total: number;
  upcoming: number;
  cancelled: number;
  nextAt: Date | null;
}

/**
 * The dedicated view — spec 6.3.7.
 *
 * Counts come from a grouped query rather than a query per series, because
 * this list grows with the business and a per-row count is the shape of
 * problem the job list was rebuilt to avoid.
 */
export async function listSeries(
  options: { includeFinished?: boolean; now?: Date } = {},
): Promise<SeriesSummary[]> {
  const now = options.now ?? new Date();

  const series = await prisma.jobSeries.findMany({
    orderBy: { startsAt: 'desc' },
    take: 200,
    select: {
      id: true,
      label: true,
      startsAt: true,
      cancelledAt: true,
    },
  });

  if (series.length === 0) return [];

  const ids = series.map((row) => row.id);

  const [counts, cancelled, next] = await Promise.all([
    prisma.job.groupBy({
      by: ['seriesId'],
      where: { seriesId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.job.groupBy({
      by: ['seriesId'],
      where: { seriesId: { in: ids }, status: 'CANCELLED' },
      _count: { _all: true },
    }),
    prisma.job.groupBy({
      by: ['seriesId'],
      where: {
        seriesId: { in: ids },
        scheduledAt: { gte: now },
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
      },
      _count: { _all: true },
      _min: { scheduledAt: true },
    }),
  ]);

  const total = new Map(counts.map((row) => [row.seriesId, row._count._all]));
  const dead = new Map(cancelled.map((row) => [row.seriesId, row._count._all]));
  const ahead = new Map(
    next.map((row) => [row.seriesId, { count: row._count._all, at: row._min.scheduledAt }]),
  );

  const summaries = series.map((row) => ({
    ...row,
    total: total.get(row.id) ?? 0,
    cancelled: dead.get(row.id) ?? 0,
    upcoming: ahead.get(row.id)?.count ?? 0,
    nextAt: ahead.get(row.id)?.at ?? null,
  }));

  // A series whose jobs are all in the past is clutter on a screen whose
  // purpose is managing what is still to come.
  return options.includeFinished
    ? summaries
    : summaries.filter((row) => row.upcoming > 0 || row.cancelledAt === null);
}

export async function getSeries(id: string) {
  return prisma.jobSeries.findUnique({
    where: { id },
    include: {
      jobs: {
        orderBy: { scheduledAt: 'asc' },
        select: {
          id: true,
          reference: true,
          scheduledAt: true,
          status: true,
          seriesIndex: true,
          clientPricePence: true,
          driver: { select: { id: true, name: true } },
        },
      },
      createdBy: { select: { id: true, name: true } },
    },
  });
}

/**
 * Stop a series being extended — spec 6.3.6.
 *
 * Marks the series only. Cancelling the jobs is a separate, explicit act
 * through the ordinary transition path, because each one is a booking a
 * client may be expecting and cancelling it silently as a side effect of
 * tidying up a rule is exactly the kind of thing this system exists to stop.
 */
export async function endSeries(id: string, context: AuditContext): Promise<void> {
  await withAudit(
    'JobSeries',
    'update',
    async (tx) => {
      const before = await tx.jobSeries.findUnique({ where: { id } });
      const after = await tx.jobSeries.update({
        where: { id },
        data: { cancelledAt: new Date() },
      });
      return { entityId: id, before, after, result: undefined };
    },
    context,
  );
}

// ------------------------------------------------------------ return journeys

/**
 * The form values for a return leg — spec 6.3.1.
 *
 * Reuses `duplicateDefaults` with the swap it already knows how to do, and
 * adds the one thing a return needs that a duplicate does not: a plausible
 * time. The suggestion is a starting point, not a rule.
 */
export function returnDefaults(
  job: Parameters<typeof duplicateDefaults>[0] & {
    scheduledAt: Date;
    estimatedMinutes?: number | null;
  },
  timeZone: string,
) {
  const at = suggestReturnAt(job.scheduledAt, job.estimatedMinutes);
  const [date, time] = toLondon(at, timeZone).split('T');

  return {
    ...duplicateDefaults(job, { swap: true }),
    scheduledDate: date!,
    scheduledTime: time!,
  };
}

/**
 * Record that one job is the return leg of another — spec 6.3.2.
 *
 * Written after the return is booked rather than as part of booking it, so a
 * failure here costs the link and not the job. A booking that exists without
 * its link is a display problem; a link that took the booking down with it
 * is a lost fare.
 *
 * Refuses to link a job to itself, or to an outbound that already has a
 * return — the second of which the unique constraint would refuse anyway,
 * but a clear message beats a constraint violation.
 */
export async function linkReturn(
  outboundJobId: string,
  returnJobId: string,
  context: AuditContext,
): Promise<void> {
  if (outboundJobId === returnJobId) {
    throw new RecurrenceError('A job cannot be its own return');
  }

  const existing = await prisma.job.findFirst({
    where: { returnOfJobId: outboundJobId },
    select: { id: true, reference: true },
  });
  if (existing && existing.id !== returnJobId) {
    throw new RecurrenceError(
      `That job already has a return journey (${existing.reference})`,
    );
  }

  await withAudit(
    'Job',
    'update',
    async (tx) => {
      const before = await tx.job.findUnique({ where: { id: returnJobId } });
      const after = await tx.job.update({
        where: { id: returnJobId },
        data: { returnOfJobId: outboundJobId },
      });
      return { entityId: returnJobId, before, after, result: undefined };
    },
    context,
  );
}

/**
 * The other leg, whichever end you are standing at — spec 6.3.2.
 *
 * Both directions from one foreign key: the return points at the outbound,
 * and the outbound finds the return through the same column. Storing it
 * twice would give two places for it to disagree.
 */
export async function linkedLegs(jobId: string): Promise<{
  outbound: { id: string; reference: string; scheduledAt: Date } | null;
  returnLeg: { id: string; reference: string; scheduledAt: Date } | null;
}> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      returnOf: { select: { id: true, reference: true, scheduledAt: true } },
      returnJob: { select: { id: true, reference: true, scheduledAt: true } },
    },
  });

  return {
    outbound: job?.returnOf ?? null,
    returnLeg: job?.returnJob ?? null,
  };
}
