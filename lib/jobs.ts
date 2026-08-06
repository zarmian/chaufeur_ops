import type { JobStatus, JobType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { isDriverCompliantAt } from './compliance';
import { toUTC } from './dates';
import {
  canTransition,
  eventTypeForStatus,
  hasPriceOrReason,
  type TransitionResult,
} from './job-status';
import type { ListParams } from './list-params';
import { billedHours, calculateFinance } from './job-finance';
import { noteLocationUse } from './pricing/config';
import { parseMoney } from './money';
import { vehicleAvailableAt, type RentalRefusal } from './rentals';
import { prisma } from './prisma';
import {
  onDriverReplaced,
  onJobAssigned,
  onJobBooked,
  onJobCancelled,
  onJobEdited,
  onJobStatusChanged,
  type JobSnapshot,
} from './telegram/hooks';
import { withJobReference } from './references';
import { emptyToNull, tidy } from './text';

/**
 * Jobs — the operational core.
 *
 * The one thing this module exists to prevent: a job quietly reaching the end
 * of its life worth nothing. In the legacy system 140 of 141 jobs had no
 * price, because pricing was a modal nobody opened. Here the price is on the
 * booking form, unpriced jobs are visible in every list, and `COMPLETED` is
 * refused without either a price or a written reason.
 */

/**
 * Money arrives from the form as pounds ("125.50"), not pence.
 *
 * Blank becomes null rather than 0, and the difference is the whole point: a
 * null price is a question nobody answered, which the UI must chase. A zero
 * is a deliberate statement that the job was free, which needs a reason.
 */
const priceField = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))
  .superRefine((value, ctx) => {
    if (value === null) return;
    try {
      const pence = parseMoney(value);
      if (pence < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That cannot be negative' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 125.50' });
    }
  })
  .transform((value) => (value === null ? null : parseMoney(value)));

const optionalId = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value));

/**
 * A blank count is null, never 0.
 *
 * The blank is mapped before coercion: `z.coerce.number()` turns `''` into 0,
 * so a union that tried it first would record "0 passengers" for every job
 * where nobody filled the field in.
 */
const optionalCount = z.preprocess(
  (value) =>
    value === '' || value === null || value === undefined ? null : value,
  z.coerce.number().int().min(0).max(99).nullable(),
);

/**
 * A postcode from an address lookup.
 *
 * Stored in the canonical spaced, upper-cased form, because zone resolution
 * and every downstream comparison expect it and a lower-cased one would
 * silently fail to match.
 */
const optionalPostcode = z
  .string()
  .trim()
  .max(12)
  .optional()
  .transform((value) =>
    value === undefined || value === '' ? null : value.toUpperCase(),
  );

/**
 * A latitude or longitude.
 *
 * Blank mapped before coercion, for the same reason as `optionalCount`:
 * `z.coerce.number()` turns `''` into 0, and 0,0 is a point in the Atlantic
 * that would look like a real location on every map this ever reaches.
 */
const optionalCoordinate = z.preprocess(
  (value) =>
    value === '' || value === null || value === undefined ? null : value,
  z.coerce.number().min(-180).max(180).nullable(),
);

/**
 * One stop, as the form posts it.
 *
 * Stops arrive as parallel arrays (`stopAddress[]`, `stopCharge[]`), which is
 * how a repeating fieldset submits. They are zipped back into records in
 * `readStops` before they reach here.
 */
export const stopSchema = z.object({
  address: z.string().trim().min(1).max(500),
  waitMinutes: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : value),
    z.coerce.number().int().min(0).max(24 * 60).nullable(),
  ),
  chargePence: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value))
    .superRefine((value, ctx) => {
      if (value === null) return;
      try {
        if (parseMoney(value) < 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That cannot be negative' });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 15.00' });
      }
    })
    .transform((value) => (value === null ? null : parseMoney(value))),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export type StopInput = z.infer<typeof stopSchema>;

export const jobSchema = z
  .object({
    clientId: optionalId,
    accountId: optionalId,
    jobType: z.enum(['AS_DIRECTED', 'TRANSFER', 'AIRPORT_TRANSFER']),

    // Entered in the operator's local time; converted to UTC on save.
    scheduledDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker'),
    scheduledTime: z
      .string()
      .trim()
      .regex(/^\d{2}:\d{2}$/, 'Use a time like 14:30'),

    pickupText: z.string().trim().min(1, 'Enter the pickup').max(500),
    dropoffText: z.string().trim().min(1, 'Enter the destination').max(500),
    viaText: z.string().trim().max(500).optional().or(z.literal('')),
    pickupLocationId: optionalId,
    dropoffLocationId: optionalId,

    /**
     * From an address lookup — spec 4.8.6.5.
     *
     * Optional throughout: an operator typing a one-off address by hand is
     * still taking a booking, and refusing it because no provider is
     * configured would make address search a requirement rather than a help.
     */
    pickupPostcode: optionalPostcode,
    pickupLat: optionalCoordinate,
    pickupLng: optionalCoordinate,
    dropoffPostcode: optionalPostcode,
    dropoffLat: optionalCoordinate,
    dropoffLng: optionalCoordinate,

    driverId: optionalId,
    vehicleId: optionalId,

    passengerName: z.string().trim().max(200).optional().or(z.literal('')),
    passengerPhone: z.string().trim().max(40).optional().or(z.literal('')),
    passengerCount: optionalCount,
    luggageCount: optionalCount,
    flightNumber: z.string().trim().max(20).optional().or(z.literal('')),

    clientPricePence: priceField,
    driverPricePence: priceField,
    zeroValueReason: z.string().trim().max(500).optional().or(z.literal('')),

    /**
     * What the rate card suggested, and which rule said so — spec 4.2.7 and
     * 4.2.8.
     *
     * The suggestion is recorded, never trusted: the saved price is whatever
     * is in the price field, and these exist so the audit entry can say what
     * the card offered alongside what the operator actually agreed. A fare
     * that departs from the card is a commercial decision, and the whole
     * point of recording it is being able to see how often it happens.
     */
    rateCardRuleId: optionalId,
    suggestedClientPricePence: priceField,
    suggestedDriverPricePence: priceField,

    notes: z.string().trim().max(5000).optional().or(z.literal('')),
    internalNotes: z.string().trim().max(5000).optional().or(z.literal('')),

    /**
     * Hours and hourly rate for as-directed work, asked for on the booking
     * form rather than only in the finance panel (spec 2.5.6.1). A job priced
     * by the hour whose hours live somewhere else is a job nobody prices.
     */
    customerHours: z.preprocess(
      (value) =>
        value === '' || value === null || value === undefined ? null : value,
      z.coerce.number().min(0).max(999.99).nullable(),
    ),
    customerRatePence: priceField,
    minimumHours: z.preprocess(
      (value) =>
        value === '' || value === null || value === undefined ? null : value,
      z.coerce.number().min(0).max(999.99).nullable(),
    ),

    stops: z.array(stopSchema).max(20, 'That is more stops than a job can have').default([]),

    /** Attributes the job to a hired driver's shift. */
    shiftId: optionalId,
    engagementKind: z
      .enum(['OWNER_DRIVER', 'HIRED'])
      .optional()
      .or(z.literal(''))
      .transform((value) => (value === '' || value === undefined ? null : value)),

    estimatedMinutes: z.preprocess(
      (value) =>
        value === '' || value === null || value === undefined ? null : value,
      z.coerce
        .number()
        .int()
        .min(0)
        .max(24 * 60)
        .nullable(),
    ),
  })
  .superRefine((input, ctx) => {
    // A flight number on a non-airport job is almost always a mis-selected
    // job type, and it would never be displayed — so say so rather than
    // silently dropping it.
    if (input.flightNumber && input.jobType !== 'AIRPORT_TRANSFER') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flightNumber'],
        message: 'Flight numbers belong to airport transfers',
      });
    }
  });

export type JobInput = z.infer<typeof jobSchema>;

/** Combine the two form fields into the single UTC instant the schema stores. */
export function scheduledAtFrom(
  input: Pick<JobInput, 'scheduledDate' | 'scheduledTime'>,
  timeZone?: string,
): Date {
  return toUTC(`${input.scheduledDate}T${input.scheduledTime}`, timeZone);
}

function toData(input: JobInput, timeZone?: string) {
  return {
    clientId: input.clientId,
    accountId: input.accountId,
    jobType: input.jobType,
    scheduledAt: scheduledAtFrom(input, timeZone),
    estimatedMinutes: input.estimatedMinutes,

    pickupText: tidy(input.pickupText),
    pickupLocationId: input.pickupLocationId,
    pickupPostcode: input.pickupPostcode,
    pickupLat: input.pickupLat,
    pickupLng: input.pickupLng,
    dropoffText: tidy(input.dropoffText),
    dropoffLocationId: input.dropoffLocationId,
    dropoffPostcode: input.dropoffPostcode,
    dropoffLat: input.dropoffLat,
    dropoffLng: input.dropoffLng,
    viaText: emptyToNull(input.viaText),

    driverId: input.driverId,
    vehicleId: input.vehicleId,

    passengerName: emptyToNull(input.passengerName),
    passengerPhone: emptyToNull(input.passengerPhone),
    passengerCount: input.passengerCount,
    luggageCount: input.luggageCount,
    // Only airport transfers carry one; the schema refuses it elsewhere.
    flightNumber:
      input.jobType === 'AIRPORT_TRANSFER' ? emptyToNull(input.flightNumber) : null,

    clientPricePence: input.clientPricePence,
    driverPricePence: input.driverPricePence,
    zeroValueReason: emptyToNull(input.zeroValueReason),
    rateCardRuleId: input.rateCardRuleId,

    notes: emptyToNull(input.notes),
    internalNotes: emptyToNull(input.internalNotes),

    shiftId: input.shiftId,
    engagementKind: input.engagementKind,
  };
}

/**
 * What the rate card offered, and whether the operator took it — spec 4.2.8.
 *
 * Recorded on the `PRICE_SET` event rather than only in the audit snapshot,
 * because the question this answers is about a decision, not a field: an
 * override that happens on one job in twenty is a rate card working, and one
 * that happens on nineteen is a rate card nobody believes.
 *
 * Absent entirely when nothing was suggested, so the metadata never implies
 * a card had an opinion it did not have.
 */
function rateCardMetadata(
  input: JobInput,
  saved: { clientPricePence: number | null; driverPricePence: number | null },
): Record<string, unknown> {
  if (!input.rateCardRuleId || input.suggestedClientPricePence === null) {
    return {};
  }

  const overridden = saved.clientPricePence !== input.suggestedClientPricePence;

  return {
    rateCardRuleId: input.rateCardRuleId,
    suggestedClientPricePence: input.suggestedClientPricePence,
    suggestedDriverPricePence: input.suggestedDriverPricePence,
    priceSource: overridden ? 'OVERRIDE' : 'RATE_CARD',
    ...(overridden
      ? {
          overrideDeltaPence:
            (saved.clientPricePence ?? 0) - input.suggestedClientPricePence,
        }
      : {}),
  };
}

/** The stop rows to persist, numbered from one in the order given. */
function toStopData(stops: StopInput[]) {
  return stops.map((stop, index) => ({
    sequence: index + 1,
    address: tidy(stop.address),
    waitMinutes: stop.waitMinutes,
    chargePence: stop.chargePence,
    note: emptyToNull(stop.note),
  }));
}

/**
 * The finance figures a booking implies, when it was priced by the hour.
 *
 * Written to `JobFinance` at booking so an as-directed job has a total from
 * the moment it is taken, rather than reading as unpriced until someone opens
 * the panel. The minimum-hours rule is applied here, once, so the quote and
 * the invoice cannot disagree.
 */
function hourlyFinanceFor(input: JobInput) {
  const hours = billedHours(input.customerHours, input.minimumHours);
  if (hours === null || !input.customerRatePence) return null;

  const amounts = {
    baseFarePence: input.clientPricePence ?? 0,
    customerHours: hours,
    customerRatePence: input.customerRatePence,
    driverPaymentPence: input.driverPricePence ?? 0,
  };
  const totals = calculateFinance(amounts);

  return {
    baseFarePence: amounts.baseFarePence,
    customerHours: hours,
    customerRatePence: input.customerRatePence,
    driverPaymentPence: amounts.driverPaymentPence,
    totalClientPence: totals.totalClientPence,
    totalCostsPence: totals.totalCostsPence,
    grossProfitPence: totals.grossProfitPence,
  };
}

// ------------------------------------------------------------------ listing

export interface JobListFilters {
  status: string | null;
  jobType: string | null;
  driverId: string | null;
  clientId: string | null;
  accountId: string | null;
  vehicleId: string | null;
  /** Inclusive, as local date strings. */
  from: string | null;
  to: string | null;
  unpricedOnly: boolean;
}

/** Columns the list may be sorted by, mapped to Prisma order clauses. */
const SORTABLE = {
  scheduledAt: (dir: 'asc' | 'desc') => ({ scheduledAt: dir }),
  reference: (dir: 'asc' | 'desc') => ({ reference: dir }),
  client: (dir: 'asc' | 'desc') => ({ client: { name: dir } }),
  driver: (dir: 'asc' | 'desc') => ({ driver: { name: dir } }),
  clientPrice: (dir: 'asc' | 'desc') => ({ clientPricePence: dir }),
  grossProfit: (dir: 'asc' | 'desc') => ({ finance: { grossProfitPence: dir } }),
} as const;

export type JobSortKey = keyof typeof SORTABLE;

export function isSortableJobKey(key: string | null): key is JobSortKey {
  // `in` walks the prototype chain, so `?sort=__proto__` would pass and then
  // resolve to Object.prototype rather than an order-by builder. The sort key
  // comes straight from the URL, so own-property is the only safe test.
  return key !== null && Object.hasOwn(SORTABLE, key);
}

/**
 * "Unpriced" in SQL: no positive client price, and no written reason.
 *
 * Kept beside `hasPriceOrReason` in `job-status.ts` deliberately — the two
 * must agree, and a comment is cheaper than a divergence. `zeroValueReason`
 * is stored trimmed-or-null, so an empty-string check is not needed here.
 */
export const UNPRICED_WHERE = {
  AND: [
    { OR: [{ clientPricePence: null }, { clientPricePence: { lte: 0 } }] },
    { zeroValueReason: null },
  ],
} satisfies Prisma.JobWhereInput;

export function buildJobWhere(
  params: Pick<ListParams, 'q'>,
  filters: JobListFilters,
  timeZone?: string,
): Prisma.JobWhereInput {
  const where: Prisma.JobWhereInput = {};

  if (filters.status) where.status = filters.status as JobStatus;
  if (filters.jobType) where.jobType = filters.jobType as JobType;
  if (filters.driverId) where.driverId = filters.driverId;
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.accountId) where.accountId = filters.accountId;
  if (filters.vehicleId) where.vehicleId = filters.vehicleId;

  if (filters.from || filters.to) {
    where.scheduledAt = {
      // The operator types a London date; the boundary has to be the start of
      // that day in London, which is not midnight UTC for half the year.
      ...(filters.from ? { gte: toUTC(`${filters.from}T00:00`, timeZone) } : {}),
      ...(filters.to ? { lte: toUTC(`${filters.to}T23:59:59`, timeZone) } : {}),
    };
  }

  const and: Prisma.JobWhereInput[] = [];
  if (filters.unpricedOnly) and.push(UNPRICED_WHERE);

  if (params.q) {
    const contains = { contains: params.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { reference: contains },
        { pickupText: contains },
        { dropoffText: contains },
        { client: { name: contains } },
        { driver: { name: contains } },
        { account: { name: contains } },
      ],
    });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

const LIST_SELECT = {
  id: true,
  reference: true,
  scheduledAt: true,
  jobType: true,
  status: true,
  pickupText: true,
  dropoffText: true,
  clientPricePence: true,
  driverPricePence: true,
  zeroValueReason: true,
  client: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, registration: true } },
  finance: { select: { grossProfitPence: true, totalClientPence: true } },
} satisfies Prisma.JobSelect;

export type JobListRow = Prisma.JobGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * One page of jobs, plus the counts the header needs.
 *
 * The unpriced count is a separate aggregate over the same filter rather than
 * a count of the current page — "12 unpriced" has to mean twelve in this
 * view, not twelve on this screen.
 */
export async function listJobs(
  params: ListParams,
  filters: JobListFilters,
  timeZone?: string,
): Promise<{ rows: JobListRow[]; total: number; unpriced: number }> {
  const where = buildJobWhere(params, filters, timeZone);

  const sortKey = isSortableJobKey(params.sort) ? params.sort : 'scheduledAt';
  const orderBy = SORTABLE[sortKey](params.dir);

  const [rows, total, unpriced] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy,
      skip: params.skip,
      take: params.take,
      select: LIST_SELECT,
    }),
    prisma.job.count({ where }),
    // Nested, not spread. `UNPRICED_WHERE` is itself `{ AND: [...] }`, so
    // spreading it over `where` *replaces* the filter's own AND clause —
    // silently dropping the search term and counting unpriced jobs across the
    // whole database. "12 unpriced" has to mean twelve in this view.
    prisma.job.count({ where: { AND: [where, UNPRICED_WHERE] } }),
  ]);

  return { rows, total, unpriced };
}

export async function getJob(id: string) {
  return prisma.job.findUnique({
    where: { id },
    include: {
      client: true,
      account: true,
      driver: { select: { id: true, name: true, reference: true, phone: true } },
      vehicle: { select: { id: true, registration: true, make: true, model: true } },
      finance: true,
      events: { orderBy: { occurredAt: 'asc' } },
      expenses: { orderBy: { createdAt: 'asc' } },
      stops: { orderBy: { sequence: 'asc' } },
      shift: {
        select: {
          id: true,
          reference: true,
          driver: { select: { name: true } },
        },
      },
      createdBy: { select: { id: true, name: true } },
      // Spec 6.3.2 — both directions of the return link, from one column, so
      // the two can never disagree about which leg is which.
      returnOf: { select: { id: true, reference: true, scheduledAt: true } },
      returnJob: { select: { id: true, reference: true, scheduledAt: true } },
      // Spec 6.3.7 — enough to say "3 of 12" and offer the way back to the
      // series, without loading its other eleven jobs.
      series: { select: { id: true, label: true, cancelledAt: true } },
      invoiceLines: {
        select: {
          invoice: { select: { id: true, number: true, status: true } },
        },
      },
    },
  });
}

// ----------------------------------------------------------------- mutation

/**
 * Create a job, allocating its reference and writing the `CREATED` event in
 * the same transaction as the row.
 *
 * A job that exists without a creation event would leave a gap in the
 * timeline that nothing could later reconstruct, so the two are atomic.
 */
export async function createJob(
  input: JobInput,
  context: AuditContext,
  timeZone?: string,
): Promise<{ id: string; reference: string }> {
  noteLocationsUsed(input);

  const booked = await withJobReference((reference) =>
    withAudit(
      'Job',
      'create',
      async (tx) => {
        const created = await tx.job.create({
          data: {
            ...toData(input, timeZone),
            reference,
            status: 'PENDING',
            createdById: context.userId ?? null,
            ...(input.stops.length > 0
              ? { stops: { create: toStopData(input.stops) } }
              : {}),
          },
        });

        const hourly = hourlyFinanceFor(input);
        if (hourly) {
          await tx.jobFinance.create({ data: { ...hourly, jobId: created.id } });
        }

        await tx.jobEvent.create({
          data: {
            jobId: created.id,
            type: 'CREATED',
            actorType: 'USER',
            actorId: context.userId ?? null,
          },
        });

        // A price agreed at booking is itself a recorded decision.
        if (hasPriceOrReason(created)) {
          await tx.jobEvent.create({
            data: {
              jobId: created.id,
              type: 'PRICE_SET',
              actorType: 'USER',
              actorId: context.userId ?? null,
              metadata: {
                clientPricePence: created.clientPricePence,
                driverPricePence: created.driverPricePence,
                ...rateCardMetadata(input, created),
              },
            },
          });
        }

        return {
          entityId: created.id,
          after: created,
          result: { id: created.id, reference: created.reference },
        };
      },
      context,
    ),
  );

  // After the commit, and never allowed to fail it — spec 5.10.3.
  await onJobBooked(booked.id);

  return booked;
}

/**
 * Bump the use count of any saved location this booking named — spec 4.1.6.
 *
 * Deliberately outside the transaction and never awaited into the caller's
 * error path: it orders an autocomplete list, and a booking must not fail
 * because a counter did.
 */
function noteLocationsUsed(input: JobInput): void {
  void noteLocationUse([
    input.pickupText,
    input.dropoffText,
    ...input.stops.map((stop) => stop.address),
  ]);
}

export async function updateJob(
  id: string,
  input: JobInput,
  context: AuditContext,
  timeZone?: string,
): Promise<{ id: string }> {
  noteLocationsUsed(input);

  // Captured inside the transaction and acted on after it commits. A driver
  // told about a change that then rolled back is worse than one told late.
  let snapshots: {
    before: JobSnapshot;
    after: JobSnapshot;
    previousDriverId: string | null;
    nextDriverId: string | null;
  } | null = null;

  const result = await withAudit(
    'Job',
    'update',
    async (tx) => {
      const before = await tx.job.findUniqueOrThrow({ where: { id } });
      const after = await tx.job.update({
        where: { id },
        data: {
          ...toData(input, timeZone),
          // Replaced wholesale rather than diffed. Stops are ordered and
          // typically few; matching them up by position would silently
          // reassign a charge when one is deleted from the middle.
          stops: { deleteMany: {}, create: toStopData(input.stops) },
        },
      });

      await tx.jobEvent.create({
        data: {
          jobId: id,
          type: 'EDITED',
          actorType: 'USER',
          actorId: context.userId ?? null,
        },
      });

      // Surfaced separately from a general edit, because "who set this price
      // and when" is the question the legacy system could never answer.
      if (before.clientPricePence !== after.clientPricePence) {
        await tx.jobEvent.create({
          data: {
            jobId: id,
            type: 'PRICE_SET',
            actorType: 'USER',
            actorId: context.userId ?? null,
            metadata: {
              fromPence: before.clientPricePence,
              toPence: after.clientPricePence,
              ...rateCardMetadata(input, after),
            },
          },
        });
      }

      snapshots = {
        before: snapshotOf(before),
        after: snapshotOf(after),
        previousDriverId: before.driverId,
        nextDriverId: after.driverId,
      };

      return { entityId: id, before, after, result: { id } };
    },
    context,
  );

  if (snapshots) {
    const { before, after, previousDriverId, nextDriverId } =
      snapshots as NonNullable<typeof snapshots>;

    if (previousDriverId && previousDriverId !== nextDriverId) {
      await onDriverReplaced(id, previousDriverId);
      if (nextDriverId) await onJobAssigned(id);
    } else {
      await onJobEdited(id, before, after);
    }
  }

  return result;
}

/** Only the fields a driver acts on, for the change notice. */
function snapshotOf(job: {
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  flightNumber: string | null;
  passengerName: string | null;
}): JobSnapshot {
  return {
    scheduledAt: job.scheduledAt,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    flightNumber: job.flightNumber,
    passengerName: job.passengerName,
  };
}

/**
 * Move a job to `next`, or explain why not.
 *
 * The guards run against freshly-read state inside the transaction, so a
 * price removed in another tab between the button rendering and the click
 * cannot slip a £0 job through to `COMPLETED`.
 */
export async function transitionJob(
  id: string,
  next: JobStatus,
  context: AuditContext,
  options: { zeroValueReason?: string | null } = {},
): Promise<TransitionResult & { reference?: string }> {
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      reference: true,
      status: true,
      driverId: true,
      vehicleId: true,
      scheduledAt: true,
      clientPricePence: true,
      zeroValueReason: true,
      invoiceLines: {
        select: { invoice: { select: { number: true, status: true } } },
      },
    },
  });

  if (!job) {
    return { ok: false, code: 'INVALID_TRANSITION', message: 'That job no longer exists' };
  }

  // A reason supplied with the click counts, so completing an unpriced job is
  // one step rather than "save, then retry".
  const zeroValueReason =
    options.zeroValueReason !== undefined && options.zeroValueReason !== null
      ? emptyToNull(options.zeroValueReason)
      : job.zeroValueReason;

  const locked = job.invoiceLines
    .map((line) => line.invoice)
    .find((invoice) => invoice && ['SENT', 'PAID'].includes(invoice.status));

  // Only fetched when assignment is actually in play — it costs a few
  // queries. Goes through checkAssignmentCompliance rather than
  // isDriverCompliantAt directly, so a car out on rent is refused here too
  // and not only on the form.
  const compliance =
    next === 'ASSIGNED' && job.driverId
      ? await checkAssignmentCompliance(job.driverId, job.vehicleId, job.scheduledAt)
      : null;

  const verdict = canTransition(
    {
      status: job.status,
      driverId: job.driverId,
      vehicleId: job.vehicleId,
      clientPricePence: job.clientPricePence,
      zeroValueReason,
      lockedByInvoice: locked
        ? { reference: locked.number, status: locked.status }
        : null,
      compliance: compliance
        ? { compliant: compliance.compliant, reasons: compliance.reasons }
        : null,
    },
    next,
  );

  if (!verdict.ok) return verdict;

  const eventType = eventTypeForStatus(next);

  await withAudit(
    'Job',
    'update',
    async (tx) => {
      const before = await tx.job.findUniqueOrThrow({ where: { id } });
      const after = await tx.job.update({
        where: { id },
        data: {
          status: next,
          ...(zeroValueReason !== job.zeroValueReason ? { zeroValueReason } : {}),
        },
      });

      // Same transaction as the status write, so the log can never disagree
      // with the column it explains.
      if (eventType) {
        await tx.jobEvent.create({
          data: {
            jobId: id,
            type: eventType,
            actorType: 'USER',
            actorId: context.userId ?? null,
            ...(zeroValueReason ? { metadata: { zeroValueReason } } : {}),
          },
        });
      }

      return { entityId: id, before, after, result: null };
    },
    context,
  );

  // After the commit, and never allowed to fail it.
  if (next === 'ASSIGNED') await onJobAssigned(id);
  else if (next === 'CANCELLED') await onJobCancelled(id);
  else await onJobStatusChanged(id);

  return { ok: true, reference: job.reference };
}

// ---------------------------------------------------------------- conflicts

export interface DriverConflict {
  id: string;
  reference: string;
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
}

/**
 * Other live jobs for this driver near `scheduledAt`.
 *
 * A warning, never a block (spec 2.1.8). Two airport runs ninety minutes
 * apart may be perfectly workable, and the operator knows the traffic and the
 * driver; the system does not. Blocking here would teach people to route
 * around the system, which is how the legacy spreadsheet happened.
 */
export async function findDriverConflicts(
  driverId: string,
  scheduledAt: Date,
  bufferMinutes: number,
  excludeJobId?: string,
): Promise<DriverConflict[]> {
  const window = bufferMinutes * 60 * 1000;

  return prisma.job.findMany({
    where: {
      driverId,
      status: { notIn: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] },
      scheduledAt: {
        gte: new Date(scheduledAt.getTime() - window),
        lte: new Date(scheduledAt.getTime() + window),
      },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
    },
    orderBy: { scheduledAt: 'asc' },
    take: 5,
  });
}

/**
 * The compliance verdict for a proposed driver/vehicle pairing at a proposed
 * time — what the create form calls before allowing submission (spec 2.1.7).
 *
 * A car out on rent is folded in as a reason alongside the document checks.
 * From the operator's point of view it is the same problem — this car cannot
 * go on this job — and splitting it across two alerts would just mean fixing
 * one and being refused by the other.
 */
export async function checkAssignmentCompliance(
  driverId: string | null,
  vehicleId: string | null,
  scheduledAt: Date,
) {
  if (!driverId) return null;

  const compliance = await isDriverCompliantAt(driverId, scheduledAt, { vehicleId });
  if (!vehicleId) return compliance;

  const availability = await checkVehicleAvailability(vehicleId, scheduledAt);
  if (availability.ok) return compliance;

  return {
    ...compliance,
    compliant: false,
    reasons: [...compliance.reasons, availability.message],
  };
}

/** Is this car free of rentals at `at`? (spec 2.5.3.10) */
export async function checkVehicleAvailability(
  vehicleId: string,
  at: Date,
): Promise<RentalRefusal> {
  const rentals = await prisma.vehicleRental.findMany({
    where: {
      vehicleId,
      status: { not: 'CANCELLED' },
      startAt: { lte: at },
    },
    select: {
      reference: true,
      startAt: true,
      endAt: true,
      returnedAt: true,
      status: true,
    },
  });

  return vehicleAvailableAt(rentals, at);
}

/** Completed jobs that were never priced — the dashboard tile and the digest. */
export async function countUnpricedCompleted(): Promise<number> {
  return prisma.job.count({
    where: { status: 'COMPLETED', ...UNPRICED_WHERE },
  });
}

export async function listUnpricedCompleted(limit = 100) {
  return prisma.job.findMany({
    where: { status: 'COMPLETED', ...UNPRICED_WHERE },
    orderBy: { scheduledAt: 'desc' },
    take: limit,
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      client: { select: { name: true } },
      driver: { select: { name: true } },
    },
  });
}

/** A nullable number as a form field holds it. */
function asField(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * Pre-fill for "duplicate job" and "create return journey" (spec 2.3.8–9).
 *
 * The date is deliberately cleared on a duplicate: a copied job with its
 * original date silently books something for last Tuesday.
 */
export function duplicateDefaults(
  job: {
    clientId: string | null;
    accountId: string | null;
    jobType: JobType;
    pickupText: string;
    pickupPostcode: string | null;
    pickupLat: number | null;
    pickupLng: number | null;
    dropoffText: string;
    dropoffPostcode: string | null;
    dropoffLat: number | null;
    dropoffLng: number | null;
    viaText: string | null;
    driverId: string | null;
    vehicleId: string | null;
    passengerName: string | null;
    passengerPhone: string | null;
    passengerCount: number | null;
    luggageCount: number | null;
    clientPricePence: number | null;
    driverPricePence: number | null;
    notes: string | null;
  },
  options: { swap?: boolean } = {},
) {
  return {
    clientId: job.clientId ?? '',
    accountId: job.accountId ?? '',
    jobType: job.jobType,
    scheduledDate: '',
    scheduledTime: '',
    // Swapped together with the text, or a return journey would carry the
    // outbound leg's coordinates and price from the wrong zone.
    pickupText: options.swap ? job.dropoffText : job.pickupText,
    pickupPostcode: (options.swap ? job.dropoffPostcode : job.pickupPostcode) ?? '',
    pickupLat: asField(options.swap ? job.dropoffLat : job.pickupLat),
    pickupLng: asField(options.swap ? job.dropoffLng : job.pickupLng),
    dropoffText: options.swap ? job.pickupText : job.dropoffText,
    dropoffPostcode: (options.swap ? job.pickupPostcode : job.dropoffPostcode) ?? '',
    dropoffLat: asField(options.swap ? job.pickupLat : job.dropoffLat),
    dropoffLng: asField(options.swap ? job.pickupLng : job.dropoffLng),
    viaText: job.viaText ?? '',
    driverId: job.driverId ?? '',
    vehicleId: job.vehicleId ?? '',
    passengerName: job.passengerName ?? '',
    passengerPhone: job.passengerPhone ?? '',
    passengerCount: job.passengerCount ?? '',
    luggageCount: job.luggageCount ?? '',
    clientPricePence: job.clientPricePence,
    driverPricePence: job.driverPricePence,
    notes: job.notes ?? '',
  };
}
