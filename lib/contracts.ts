import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { fromDateOnlyString, toDateOnlyString } from './dates';
import {
  calculateFinance,
  financeAmountsFrom,
  type FinanceAmounts,
} from './job-finance';
import {
  checkAssignmentCompliance,
  checkVehicleAvailability,
  createJob,
  type JobInput,
} from './jobs';
import { isVehicleCompliantAt } from './compliance';
import { parseMoney } from './money';
import { prisma } from './prisma';
import { formatReference } from './references';
import { onDriverReplaced, onJobAssigned, onVehicleChanged } from './telegram/hooks';
import { emptyToNull, tidy } from './text';
import type { RepriceScope } from './enum-options';

/**
 * Standing contracts — spec 6.6.
 *
 * A school run, a daily office collection, an executive on retainer. The
 * contract holds what each day looks like and what a day is worth; the cron
 * turns it into one ordinary job per day, a few days ahead.
 *
 * Three things follow from it being an arrangement rather than a booking:
 *
 * **There is no required end.** Most of these run until somebody stops them.
 * Forcing an end date would either invent one or leave the arrangement
 * unrecordable, and a system that cannot record the work is one people keep a
 * spreadsheet beside.
 *
 * **The days it makes are ordinary jobs.** They can be reassigned, repriced,
 * cancelled and invoiced individually, and by default nothing here reaches
 * back into one once it exists — the same rule `lib/series.ts` is built
 * around, for the same reason: by the time anybody edits a contract, some of
 * its days have drivers assigned and prices agreed.
 *
 * There are exactly two exceptions, both asked for explicitly on the edit
 * form and both reporting what they did and did not touch:
 * `repriceContractJobs` for a rate agreed after the fact, and
 * `reassignContractJobs` for a contract that changes driver or car. Each is
 * narrower than it looks — neither will overwrite a decision somebody made
 * about a particular day. If a third is ever added, it needs the same shape,
 * because the failure they all avoid is the system quietly editing bookings a
 * client is already expecting.
 *
 * **Nothing is reserved.** The driver and the car named here are who normally
 * does it, not who is locked to it. A contract day raises no clash warning at
 * all (see `lib/conflicts.ts`), because the whole point of a standing
 * arrangement is that everyone works around it.
 */

export const CONTRACT_REFERENCE_PREFIX = 'CON';
export const CONTRACT_REFERENCE_PAD = 6;

/** How far ahead the cron will ever book, whatever a contract asks for. */
export const MAX_GENERATE_AHEAD_DAYS = 90;

const money = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? '0' : value))
  .superRefine((value, ctx) => {
    try {
      if (parseMoney(value) < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That cannot be negative' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 400.00' });
    }
  })
  .transform((value) => parseMoney(value));

const optionalInt = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().int().min(0).max(24 * 60).nullable(),
);

const dateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker');

export const contractSchema = z
  .object({
    label: z.string().trim().min(1, 'Give it a name').max(200),
    clientId: z.string().trim().optional().or(z.literal('')),
    accountId: z.string().trim().optional().or(z.literal('')),

    pickupText: z.string().trim().min(1, 'Enter the pickup').max(500),
    dropoffText: z.string().trim().min(1, 'Enter the destination').max(500),
    viaText: z.string().trim().max(500).optional().or(z.literal('')),
    pickupPostcode: z.string().trim().max(12).optional().or(z.literal('')),
    dropoffPostcode: z.string().trim().max(12).optional().or(z.literal('')),
    startTime: z
      .string()
      .trim()
      .regex(/^\d{2}:\d{2}$/, 'Use a time like 09:00'),
    estimatedMinutes: optionalInt,
    passengerName: z.string().trim().max(200).optional().or(z.literal('')),
    passengerPhone: z.string().trim().max(40).optional().or(z.literal('')),

    driverId: z.string().trim().optional().or(z.literal('')),
    vehicleId: z.string().trim().optional().or(z.literal('')),

    /** 0 = Sunday. Empty means every day. */
    weekdays: z.array(z.coerce.number().int().min(0).max(6)).default([]),

    startsOn: dateOnly,
    /** Blank is open-ended, and is the normal case. */
    endsOn: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === undefined || value === '' ? null : value))
      .refine(
        (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
        'Use the date picker',
      ),

    dayRatePence: money,
    driverDayRatePence: money,
    vatTreatment: z
      .enum(['STANDARD', 'INCLUSIVE', 'EXEMPT'])
      .optional()
      .or(z.literal('')),

    generateAheadDays: z.coerce
      .number()
      .int()
      .min(1, 'Book at least a day ahead')
      .max(MAX_GENERATE_AHEAD_DAYS)
      .default(14),

    notes: z.string().trim().max(5000).optional().or(z.literal('')),
  })
  .superRefine((input, ctx) => {
    if (input.endsOn && input.endsOn < input.startsOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsOn'],
        message: 'The contract cannot end before it starts',
      });
    }

    // A contract with no day rate would generate a job a day, forever, each
    // worth nothing — the silent-zero failure this system exists to prevent,
    // multiplied by however long nobody noticed.
    if (input.dayRatePence <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dayRatePence'],
        message: 'Enter the day rate — a contract with no rate bills nothing, every day',
      });
    }

    if (!input.clientId && !input.accountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountId'],
        message: 'Choose who this is for — every day it makes has to be billable to somebody',
      });
    }
  });

export type ContractInput = z.infer<typeof contractSchema>;

async function nextContractReference(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING(reference FROM ${`^${CONTRACT_REFERENCE_PREFIX}-(\\d+)$`}) AS INTEGER)) AS max
    FROM "JobContract"
    WHERE reference ~ ${`^${CONTRACT_REFERENCE_PREFIX}-\\d+$`}
  `;
  return formatReference(
    CONTRACT_REFERENCE_PREFIX,
    (rows[0]?.max ?? 0) + 1,
    CONTRACT_REFERENCE_PAD,
  );
}

function toData(input: ContractInput) {
  return {
    label: tidy(input.label),
    clientId: emptyToNull(input.clientId),
    accountId: emptyToNull(input.accountId),
    pickupText: tidy(input.pickupText),
    dropoffText: tidy(input.dropoffText),
    viaText: emptyToNull(input.viaText),
    pickupPostcode: emptyToNull(input.pickupPostcode)?.toUpperCase() ?? null,
    dropoffPostcode: emptyToNull(input.dropoffPostcode)?.toUpperCase() ?? null,
    startTime: input.startTime,
    estimatedMinutes: input.estimatedMinutes,
    passengerName: emptyToNull(input.passengerName),
    passengerPhone: emptyToNull(input.passengerPhone),
    driverId: emptyToNull(input.driverId),
    vehicleId: emptyToNull(input.vehicleId),
    weekdays: input.weekdays,
    startsOn: fromDateOnlyString(input.startsOn),
    endsOn: input.endsOn ? fromDateOnlyString(input.endsOn) : null,
    dayRatePence: input.dayRatePence,
    driverDayRatePence: input.driverDayRatePence,
    vatTreatment: input.vatTreatment ? input.vatTreatment : null,
    generateAheadDays: input.generateAheadDays,
    notes: emptyToNull(input.notes),
  };
}

export async function createContract(
  input: ContractInput,
  context: AuditContext,
): Promise<{ id: string; reference: string }> {
  const reference = await nextContractReference();

  return withAudit(
    'JobContract',
    'create',
    async (tx) => {
      const created = await tx.jobContract.create({
        data: { ...toData(input), reference, createdById: context.userId ?? null },
      });
      return {
        entityId: created.id,
        after: created,
        result: { id: created.id, reference: created.reference },
      };
    },
    context,
  );
}

/**
 * Change the arrangement from here on.
 *
 * Days already created are left exactly as they are. A contract whose rate
 * changes in March does not retrospectively reprice February — those days were
 * worked and, quite possibly, invoiced.
 */
export async function updateContract(
  id: string,
  input: ContractInput,
  context: AuditContext,
): Promise<{ id: string; previous: ContractCrew }> {
  return withAudit(
    'JobContract',
    'update',
    async (tx) => {
      const before = await tx.jobContract.findUniqueOrThrow({ where: { id } });
      const after = await tx.jobContract.update({
        where: { id },
        data: toData(input),
      });
      return {
        entityId: id,
        before,
        after,
        // Who was on it a moment ago. `reassignContractJobs` needs this to
        // tell a day that still follows the contract from one somebody
        // deliberately changed.
        result: {
          id,
          previous: { driverId: before.driverId, vehicleId: before.vehicleId },
        },
      };
    },
    context,
  );
}

/**
 * Who is on a contract, and who was.
 *
 * The driver and the car travel together through every decision below, because
 * the two questions are the same question: does this day still follow the
 * arrangement, or has somebody made their own call about it?
 */
export interface ContractCrew {
  driverId: string | null;
  vehicleId: string | null;
}

/** A day that cannot be moved, whatever the contract now says. */
const SETTLED_STATUSES = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'IN_PROGRESS'];

export type Reassignment =
  | { move: false; reason: string | null }
  | { move: true; driverId: string | null; vehicleId: string | null };

/**
 * What a changed contract should do to one day it already made.
 *
 * The rule, in one sentence: **a day that still carries who the contract said
 * follows the contract; a day somebody changed by hand keeps their change.**
 *
 * That second half is the part worth stating out loud, because it is the one
 * that will look wrong before it looks right. The usual car goes in for its
 * MOT on the 14th, so the operator puts that day in another car. Six weeks
 * later the contract moves to a new car permanently. Silently overwriting the
 * 14th would undo a decision somebody made for a reason nothing here can see —
 * and it would do it to a booking a client is expecting. So those days are
 * left alone and named, and the operator moves them if that is what they
 * meant. Being told is the whole difference between a system reaching into
 * your bookings and one doing what you asked.
 *
 * Pure, and tested, because every branch here is a real car arriving or not
 * arriving somewhere.
 */
export function reassignmentFor(
  day: { driverId: string | null; vehicleId: string | null; status: string },
  contract: ContractCrew,
  previous: ContractCrew,
): Reassignment {
  // A day that has run, or been called off, is history. The contract has no
  // business in it.
  if (SETTLED_STATUSES.includes(day.status)) {
    return { move: false, reason: `already ${day.status.toLowerCase().replace('_', ' ')}` };
  }

  const vehicleChanged = contract.vehicleId !== previous.vehicleId;
  const driverChanged = contract.driverId !== previous.driverId;
  if (!vehicleChanged && !driverChanged) return { move: false, reason: null };

  // Changed by hand: the day carries somebody other than who the contract had.
  // Not an error and not a conflict — a decision, which is why it survives.
  if (vehicleChanged && day.vehicleId !== previous.vehicleId) {
    return { move: false, reason: 'its car was changed on the day itself' };
  }
  if (driverChanged && day.driverId !== previous.driverId) {
    return { move: false, reason: 'its driver was changed on the day itself' };
  }

  const vehicleId = vehicleChanged ? contract.vehicleId : day.vehicleId;
  const driverId = driverChanged ? contract.driverId : day.driverId;

  // Already where it is being asked to go. Common when a day was created after
  // the contract changed, and not worth an audit row or a message to a driver.
  if (vehicleId === day.vehicleId && driverId === day.driverId) {
    return { move: false, reason: null };
  }

  return { move: true, driverId, vehicleId };
}

/**
 * How far back a rate change reaches.
 *
 * The default is `none`: a rate agreed today applies to the work you have not
 * done yet. The other two exist because a rate is often agreed *after* the
 * month it covers — a client settles on £130 in March for a run that has been
 * happening since January — and without them the operator reprices sixty jobs
 * by hand or bills the old rate and writes off the difference.
 */
export interface RepriceResult {
  repriced: number;
  /** Days left alone, and why — an invoice is the usual reason. */
  skipped: Array<{ reference: string; reason: string }>;
}

/**
 * Apply a contract's rates to days it has already made.
 *
 * Off by default, because generation makes independent jobs and reaching back
 * into them is normally exactly the wrong thing — see this module's header.
 * But a rate settled after the fact is a real situation, and the alternative
 * is repricing sixty jobs by hand.
 *
 * **An invoiced day is never touched.** The client is holding a document with
 * a figure on it; changing the job underneath would leave the two disagreeing
 * with nothing to say which is right. Those days are reported by reference so
 * the operator can credit the invoice and decide, rather than being silently
 * skipped.
 *
 * Everything else on a day is preserved. Waiting time, extra charges and
 * recharged expenses were recorded against that day for their own reasons; the
 * day rate is the only figure this replaces.
 */
export async function repriceContractJobs(
  contractId: string,
  scope: RepriceScope,
  context: AuditContext,
  options: { now?: Date } = {},
): Promise<RepriceResult> {
  if (scope === 'none') return { repriced: 0, skipped: [] };

  const contract = await prisma.jobContract.findUniqueOrThrow({
    where: { id: contractId },
    select: { dayRatePence: true, driverDayRatePence: true },
  });

  const now = options.now ?? new Date();

  const days = await prisma.job.findMany({
    where: {
      contractId,
      // A cancelled day is not going to be billed, so repricing it is noise.
      status: { not: 'CANCELLED' },
      ...(scope === 'upcoming' ? { scheduledAt: { gte: now } } : {}),
    },
    select: {
      id: true,
      reference: true,
      finance: true,
      invoiceLines: {
        where: { invoice: { status: { not: 'CANCELLED' } } },
        select: { invoice: { select: { number: true } } },
        take: 1,
      },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  const result: RepriceResult = { repriced: 0, skipped: [] };

  for (const day of days) {
    const invoice = day.invoiceLines[0]?.invoice.number;
    if (invoice) {
      result.skipped.push({
        reference: day.reference,
        reason: `on invoice ${invoice}`,
      });
      continue;
    }

    const existing = financeAmountsFrom(day.finance);

    // The day rate replaces the day rate and nothing else. A day that ran
    // over, or carried a car park, keeps those.
    const amounts: FinanceAmounts = {
      ...(existing ?? {}),
      customerDays: existing?.customerDays ?? 1,
      customerDayRatePence: contract.dayRatePence,
      driverDays:
        contract.driverDayRatePence > 0
          ? (existing?.driverDays ?? existing?.customerDays ?? 1)
          : null,
      driverDayRatePence: contract.driverDayRatePence,
    };
    const totals = calculateFinance(amounts);

    // The columns as Prisma wants them: the rates are non-null integers, the
    // day counts are nullable decimals.
    const written = {
      customerDays: amounts.customerDays ?? null,
      customerDayRatePence: amounts.customerDayRatePence ?? 0,
      driverDays: amounts.driverDays ?? null,
      driverDayRatePence: amounts.driverDayRatePence ?? 0,
      totalClientPence: totals.totalClientPence,
      totalCostsPence: totals.totalCostsPence,
      grossProfitPence: totals.grossProfitPence,
    };

    await withAudit(
      'JobFinance',
      'update',
      async (tx) => {
        const before = await tx.jobFinance.findUnique({ where: { jobId: day.id } });
        const after = await tx.jobFinance.upsert({
          where: { jobId: day.id },
          update: written,
          create: { ...written, jobId: day.id },
        });
        return { entityId: after.id, before: before ?? undefined, after, result: null };
      },
      context,
    );

    result.repriced += 1;
  }

  return result;
}

export interface ReassignResult {
  moved: number;
  /** Days left as they were, and why — each named so it can be dealt with. */
  skipped: Array<{ reference: string; reason: string }>;
}

/**
 * Move the days not yet started onto the contract's new driver or car.
 *
 * The one place a contract edit is allowed to reach forward into the days it
 * already made. It earns the exception because the alternative is worse than
 * the rule it breaks: a contract whose car changes permanently, with thirty
 * days already booked against the old one, otherwise means thirty jobs
 * reassigned by hand — and the day somebody misses is a driver turning up in a
 * car the client was not expecting, or in no car at all.
 *
 * Three things are never done quietly:
 *
 * **A day changed by hand keeps its change** — see `reassignmentFor`.
 *
 * **A car that cannot legally do the job is refused**, exactly as it would be
 * on the booking form. A lapsed MOT does not become acceptable because it
 * arrived through a contract, and a car out on hire that day is not available
 * just because a contract says so.
 *
 * **The driver is told.** A new driver gets the job card; the driver already
 * on it is told the car changed, because the registration is what the client
 * is watching for and what the driver has to actually go and collect.
 */
export async function reassignContractJobs(
  contractId: string,
  previous: ContractCrew,
  context: AuditContext,
  options: { now?: Date } = {},
): Promise<ReassignResult> {
  const contract = await prisma.jobContract.findUniqueOrThrow({
    where: { id: contractId },
    select: { driverId: true, vehicleId: true },
  });

  const result: ReassignResult = { moved: 0, skipped: [] };
  if (
    contract.driverId === previous.driverId &&
    contract.vehicleId === previous.vehicleId
  ) {
    return result;
  }

  const now = options.now ?? new Date();

  // Not yet started, and still ahead of us. The status filter is the real
  // guard — a job can be running late and still be `IN_PROGRESS` — and the
  // date keeps the query off the whole history of a long-standing contract.
  const days = await prisma.job.findMany({
    where: {
      contractId,
      scheduledAt: { gte: now },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'IN_PROGRESS'] },
    },
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      status: true,
      driverId: true,
      vehicleId: true,
    },
    orderBy: { scheduledAt: 'asc' },
  });

  // For the driver's message. Loaded once rather than per day.
  const registration = await registrationsFor([
    previous.vehicleId,
    contract.vehicleId,
  ]);

  for (const day of days) {
    const decision = reassignmentFor(day, contract, previous);
    if (!decision.move) {
      if (decision.reason) {
        result.skipped.push({ reference: day.reference, reason: decision.reason });
      }
      continue;
    }

    const refusal = await refuseAssignment(
      decision.driverId,
      decision.vehicleId,
      day.scheduledAt,
    );
    if (refusal) {
      result.skipped.push({ reference: day.reference, reason: refusal });
      continue;
    }

    const driverChanged = decision.driverId !== day.driverId;
    const vehicleChanged = decision.vehicleId !== day.vehicleId;

    await withAudit(
      'Job',
      'update',
      async (tx) => {
        const before = await tx.job.findUniqueOrThrow({ where: { id: day.id } });
        const after = await tx.job.update({
          where: { id: day.id },
          data: {
            driverId: decision.driverId,
            vehicleId: decision.vehicleId,
            // A new driver has accepted nothing, so an ACCEPTED day drops back
            // to ASSIGNED — the same rule bulk assignment follows. A day that
            // only changed car keeps the acceptance it already has.
            ...(driverChanged && before.status === 'ACCEPTED'
              ? { status: 'ASSIGNED' as const }
              : {}),
          },
        });
        await tx.jobEvent.create({
          data: {
            jobId: day.id,
            type: driverChanged ? 'ASSIGNED' : 'EDITED',
            actorType: 'USER',
            actorId: context.userId ?? null,
            metadata: {
              fromContract: contractId,
              ...(driverChanged ? { driverId: decision.driverId } : {}),
              ...(vehicleChanged ? { vehicleId: decision.vehicleId } : {}),
            },
          },
        });
        return { entityId: day.id, before, after, result: null };
      },
      context,
    );

    // Telling the driver is best-effort by design: Telegram being unreachable
    // must not leave the day half-moved in the database.
    if (driverChanged) {
      if (day.driverId) await onDriverReplaced(day.id, day.driverId);
      if (decision.driverId) await onJobAssigned(day.id);
    } else if (vehicleChanged) {
      await onVehicleChanged(
        day.id,
        registration.get(day.vehicleId ?? '') ?? 'none',
        registration.get(decision.vehicleId ?? '') ?? 'none',
      );
    }

    result.moved += 1;
  }

  return result;
}

/** Why this driver and car cannot do that day, or null if they can. */
async function refuseAssignment(
  driverId: string | null,
  vehicleId: string | null,
  at: Date,
): Promise<string | null> {
  if (driverId) {
    const compliance = await checkAssignmentCompliance(driverId, vehicleId, at);
    return compliance && !compliance.compliant ? compliance.reasons.join('; ') : null;
  }

  // No driver on the day, so `checkAssignmentCompliance` has nothing to say —
  // but a car with a lapsed MOT is still a car with a lapsed MOT.
  if (!vehicleId) return null;

  const compliance = await isVehicleCompliantAt(vehicleId, at);
  if (!compliance.compliant) return compliance.reasons.join('; ');

  const availability = await checkVehicleAvailability(vehicleId, at);
  return availability.ok ? null : availability.message;
}

async function registrationsFor(
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const wanted = ids.filter((id): id is string => Boolean(id));
  if (wanted.length === 0) return new Map();

  const vehicles = await prisma.vehicle.findMany({
    where: { id: { in: wanted } },
    select: { id: true, registration: true },
  });
  return new Map(vehicles.map((vehicle) => [vehicle.id, vehicle.registration]));
}

/**
 * Stop a contract making any more days.
 *
 * The days it already made are left standing: they are bookings a client is
 * expecting, and each is cancelled individually if it is not going to happen —
 * the same rule `endSeries` follows.
 */
export async function setContractActive(
  id: string,
  active: boolean,
  context: AuditContext,
): Promise<void> {
  await withAudit(
    'JobContract',
    'update',
    async (tx) => {
      const before = await tx.jobContract.findUniqueOrThrow({ where: { id } });
      const after = await tx.jobContract.update({
        where: { id },
        data: { active },
      });
      return { entityId: id, before, after, result: null };
    },
    context,
  );
}

export async function getContract(id: string) {
  return prisma.jobContract.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true } },
      account: { select: { id: true, name: true } },
      driver: { select: { id: true, name: true } },
      vehicle: { select: { id: true, registration: true } },
    },
  });
}

export async function listContracts(options: { includeEnded?: boolean } = {}) {
  return prisma.jobContract.findMany({
    where: options.includeEnded ? {} : { active: true },
    orderBy: [{ active: 'desc' }, { label: 'asc' }],
    include: {
      client: { select: { id: true, name: true } },
      account: { select: { id: true, name: true } },
      driver: { select: { id: true, name: true } },
      _count: { select: { jobs: true } },
    },
    take: 500,
  });
}

/**
 * Which dates a contract should have jobs for, up to `through`.
 *
 * Pure, so the awkward parts can be tested without a database: the weekday
 * filter, the watermark that makes a second run in the same day do nothing,
 * and the end date that stops an ended contract producing one more day.
 *
 * Dates are `YYYY-MM-DD` strings throughout rather than `Date`s. A contract
 * runs on calendar days in the operator's own zone, and doing the arithmetic
 * on instants is how a clocks change turns Monday into Sunday.
 */
export function datesToGenerate(
  contract: {
    startsOn: string;
    endsOn: string | null;
    weekdays: number[];
    generatedThroughOn: string | null;
  },
  through: string,
): string[] {
  const dates: string[] = [];

  // Start the day after the watermark, or at the beginning if nothing has
  // been generated yet. Never before the contract starts.
  const from =
    contract.generatedThroughOn && contract.generatedThroughOn >= contract.startsOn
      ? nextDate(contract.generatedThroughOn)
      : contract.startsOn;

  const last =
    contract.endsOn && contract.endsOn < through ? contract.endsOn : through;

  // A backfill bound, so a contract that started two years ago and has never
  // generated does not try to create seven hundred jobs in one cron run.
  let cursor = from;
  let guard = 0;
  while (cursor <= last && guard < MAX_GENERATE_AHEAD_DAYS * 2) {
    if (runsOn(contract.weekdays, cursor)) dates.push(cursor);
    cursor = nextDate(cursor);
    guard += 1;
  }

  return dates;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The days a contract runs, in words.
 *
 * Ordered Monday-first because that is how a week is read here, even though
 * the stored numbers are Sunday-first to match `Date.getUTCDay`.
 */
export function describeWeekdays(weekdays: number[]): string {
  if (weekdays.length === 0) return 'Every day';

  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((day) => weekdays.includes(day));
  if (ordered.length === 7) return 'Every day';
  if (
    ordered.length === 5 &&
    [1, 2, 3, 4, 5].every((day) => weekdays.includes(day))
  ) {
    return 'Weekdays';
  }
  if (ordered.length === 2 && weekdays.includes(0) && weekdays.includes(6)) {
    return 'Weekends';
  }
  return ordered.map((day) => DAY_NAMES[day]).join(', ');
}

/** Whether the contract runs on that date. An empty list means every day. */
export function runsOn(weekdays: number[], date: string): boolean {
  if (weekdays.length === 0) return true;
  return weekdays.includes(weekdayOf(date));
}

/** 0 = Sunday, matching `Date.getUTCDay` and the stored list. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export function nextDate(date: string): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export interface GenerationResult {
  contractId: string;
  reference: string;
  created: string[];
  skipped: Array<{ date: string; reason: string }>;
}

/**
 * Book the days a contract owes, up to its own horizon.
 *
 * Each day goes through `createJob`, so it gets a reference, a `CREATED`
 * event and an audit entry of its own — exactly as if an operator had booked
 * it. Sequential rather than parallel because reference allocation is a
 * counter and there is nothing to win by racing it.
 *
 * A day that already exists is skipped rather than duplicated. The watermark
 * alone would be enough for the ordinary case; the existence check is what
 * makes it safe when two cron runs overlap, or when somebody moves the
 * watermark back to fill a gap.
 */
export async function generateContractJobs(
  contractId: string,
  context: AuditContext,
  options: { today?: string; timeZone?: string } = {},
): Promise<GenerationResult> {
  const contract = await prisma.jobContract.findUniqueOrThrow({
    where: { id: contractId },
  });

  const today = options.today ?? toDateOnlyString(new Date());
  const through = addDays(today, contract.generateAheadDays);

  const wanted = datesToGenerate(
    {
      startsOn: toDateOnlyString(contract.startsOn),
      endsOn: contract.endsOn ? toDateOnlyString(contract.endsOn) : null,
      weekdays: contract.weekdays,
      generatedThroughOn: contract.generatedThroughOn
        ? toDateOnlyString(contract.generatedThroughOn)
        : null,
    },
    through,
  );

  const created: string[] = [];
  const skipped: GenerationResult['skipped'] = [];

  for (const date of wanted) {
    const already = await prisma.job.findFirst({
      where: {
        contractId,
        scheduledAt: {
          gte: new Date(`${date}T00:00:00.000Z`),
          lt: new Date(`${nextDate(date)}T00:00:00.000Z`),
        },
      },
      select: { id: true },
    });
    if (already) {
      skipped.push({ date, reason: 'already booked' });
      continue;
    }

    const input = {
      clientId: contract.clientId,
      accountId: contract.accountId,
      jobType: 'CONTRACT' as const,
      scheduledDate: date,
      scheduledTime: contract.startTime,
      pickupText: contract.pickupText,
      dropoffText: contract.dropoffText,
      viaText: contract.viaText ?? '',
      pickupLocationId: null,
      dropoffLocationId: null,
      pickupPostcode: contract.pickupPostcode,
      pickupLat: null,
      pickupLng: null,
      dropoffPostcode: contract.dropoffPostcode,
      dropoffLat: null,
      dropoffLng: null,
      driverId: contract.driverId,
      vehicleId: contract.vehicleId,
      passengerName: contract.passengerName ?? '',
      passengerPhone: contract.passengerPhone ?? '',
      passengerCount: null,
      luggageCount: null,
      flightNumber: '',
      clientPricePence: null,
      driverPricePence: null,
      zeroValueReason: '',
      vatTreatment: contract.vatTreatment ?? '',
      rateCardRuleId: null,
      suggestedClientPricePence: null,
      suggestedDriverPricePence: null,
      customerHours: null,
      customerRatePence: null,
      minimumHours: null,
      // One day, at the contract's rate. The finance row is written at
      // booking, so a contract day is never an unpriced job.
      customerDays: 1,
      customerDayRatePence: contract.dayRatePence,
      minimumDays: null,
      driverDays: contract.driverDayRatePence > 0 ? 1 : null,
      driverDayRatePence: contract.driverDayRatePence,
      stops: [],
      shiftId: null,
      engagementKind: null,
      estimatedMinutes: contract.estimatedMinutes,
      notes: '',
      internalNotes: '',
    } satisfies JobInput;

    try {
      const job = await createJob(input, context, {
        contractId,
        timeZone: options.timeZone,
      });
      created.push(job.reference);
    } catch (error) {
      // One bad day must not stop the rest. The report says which and why,
      // because a contract silently short of a Tuesday is a car that does
      // not turn up.
      skipped.push({
        date,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'could not be booked',
      });
    }
  }

  // Moved to the horizon rather than to the last date created: a contract
  // that runs Mondays only must not re-examine Tuesday to Sunday on every
  // run for the rest of its life.
  if (wanted.length > 0 || !contract.generatedThroughOn) {
    await prisma.jobContract.update({
      where: { id: contractId },
      data: {
        generatedThroughOn: fromDateOnlyString(
          contract.endsOn && toDateOnlyString(contract.endsOn) < through
            ? toDateOnlyString(contract.endsOn)
            : through,
        ),
      },
    });
  }

  return {
    contractId,
    reference: contract.reference,
    created,
    skipped,
  };
}

/**
 * Every active contract, booked forward. What the cron calls.
 *
 * One contract failing does not stop the others: they are unrelated
 * arrangements, and a report of "nine done, one failed and here is why" is
 * worth more than a run that stopped at the first problem.
 */
export async function generateAllContracts(
  context: AuditContext,
  options: { today?: string; timeZone?: string } = {},
): Promise<GenerationResult[]> {
  const today = options.today ?? toDateOnlyString(new Date());

  const due = await prisma.jobContract.findMany({
    where: {
      active: true,
      startsOn: { lte: fromDateOnlyString(addDays(today, MAX_GENERATE_AHEAD_DAYS)) },
      OR: [{ endsOn: null }, { endsOn: { gte: fromDateOnlyString(today) } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const results: GenerationResult[] = [];
  for (const contract of due) {
    try {
      results.push(await generateContractJobs(contract.id, context, options));
    } catch (error) {
      results.push({
        contractId: contract.id,
        reference: '',
        created: [],
        skipped: [
          {
            date: today,
            reason:
              error instanceof Error ? error.message.slice(0, 200) : 'generation failed',
          },
        ],
      });
    }
  }

  return results;
}
