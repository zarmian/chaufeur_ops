import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { engagementAt, type EngagementPeriod } from './engagement';
import { toUTC } from './dates';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import { formatReference } from './references';
import {
  SHIFT_REFERENCE_PAD,
  SHIFT_REFERENCE_PREFIX,
  canCloseShift,
  canOpenShift,
  canRecordShift,
  paidMinutes,
  shiftPayPence,
  shiftProfit,
  shiftsOverlap,
  type ShiftRefusal,
} from './shifts';
import {
  calculateFinance,
  financeAmountsFrom,
  jobEconomics,
  withoutDriverCost,
} from './job-finance';
import { emptyToNull } from './text';

/**
 * Persistence for shifts. The arithmetic lives in `lib/shifts.ts`; this is
 * the part that touches Postgres and writes the audit trail.
 */

/** What an `<input type="datetime-local">` sends. Matched before `toUTC`. */
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/;

export const openShiftSchema = z.object({
  driverId: z.string().trim().min(1, 'Choose a driver'),
  vehicleId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  /*
   * Kept as the wall-clock string the browser sent, not turned into a Date
   * here.
   *
   * `new Date('2026-10-13T08:00')` reads a datetime-local value in the
   * *server's* timezone, which on a deployment is UTC — so an operator typing
   * eight o'clock in British Summer Time had nine o'clock stored, and the
   * shift then read back an hour out. Harmless-looking, and not: these times
   * are a timesheet, and a shift spanning the night the clocks change would
   * have paid the wrong number of hours.
   *
   * The conversion needs the configured timezone, which is a database read,
   * so it happens in the store rather than in a synchronous schema.
   */
  startedAt: z
    .string()
    .trim()
    .min(1, 'Enter when the shift started')
    .regex(LOCAL_DATETIME_PATTERN, 'That start time was not understood'),
  breakMinutes: z.coerce.number().int().min(0).max(24 * 60).default(0),
  /** Blank falls back to the driver's engagement rate. */
  hourlyRatePence: z
    .union([z.coerce.number().int().min(0), z.literal('')])
    .optional()
    .transform((value) =>
      value === '' || value === undefined ? null : Number(value),
    ),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type OpenShiftInput = z.infer<typeof openShiftSchema>;

/**
 * A shift that has already been worked, entered after the fact.
 *
 * The same fields as opening one, plus the end — which is what makes it a
 * record of work rather than a clock-on. Somebody forgets to start a shift,
 * or a driver is told to cover at short notice and nobody is at a desk, and
 * before this there was no way to enter the day at all.
 */
export const recordShiftSchema = openShiftSchema.extend({
  endedAt: z
    .string()
    .trim()
    .min(1, 'Enter when the shift ended')
    .regex(LOCAL_DATETIME_PATTERN, 'That end time was not understood'),
});

export type RecordShiftInput = z.infer<typeof recordShiftSchema>;

async function nextShiftReference(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING(reference FROM ${`^${SHIFT_REFERENCE_PREFIX}-(\\d+)$`}) AS INTEGER)) AS max
    FROM "DriverShift"
    WHERE reference ~ ${`^${SHIFT_REFERENCE_PREFIX}-\\d+$`}
  `;
  return formatReference(
    SHIFT_REFERENCE_PREFIX,
    (rows[0]?.max ?? 0) + 1,
    SHIFT_REFERENCE_PAD,
  );
}

/** The engagement periods for a driver, in the shape `lib/engagement.ts` wants. */
export async function engagementPeriodsFor(
  driverId: string,
): Promise<EngagementPeriod[]> {
  return prisma.driverEngagement.findMany({
    where: { driverId },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      id: true,
      kind: true,
      effectiveFrom: true,
      effectiveTo: true,
      hourlyRatePence: true,
      dayRatePence: true,
      overtimeAfterMin: true,
    },
  });
}

/**
 * Open a shift.
 *
 * The rate is resolved once, here, and written onto the row. Reading it back
 * through the engagement later would re-price historic shifts whenever the
 * arrangement changed.
 */
export async function openShift(
  input: OpenShiftInput,
  context: AuditContext,
): Promise<{ ok: true; id: string; reference: string } | (ShiftRefusal & { ok: false })> {
  const { timeZone } = await getLocaleConfig();
  const startedAt = toUTC(input.startedAt, timeZone);

  const existing = await prisma.driverShift.findFirst({
    where: { driverId: input.driverId, endedAt: null },
    select: { reference: true, startedAt: true },
  });

  const allowed = canOpenShift(existing);
  if (!allowed.ok) return allowed;

  let rate = input.hourlyRatePence;
  if (rate === null) {
    const periods = await engagementPeriodsFor(input.driverId);
    rate = engagementAt(periods, startedAt)?.hourlyRatePence ?? null;
  }

  if (rate === null) {
    return {
      ok: false,
      message:
        'No hourly rate for this driver at that date. Add a hired engagement, or enter a rate for this shift.',
    };
  }

  const reference = await nextShiftReference();
  const hourlyRatePence = rate;

  return withAudit(
    'Driver',
    'update',
    async (tx) => {
      const created = await tx.driverShift.create({
        data: {
          reference,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          startedAt,
          breakMinutes: input.breakMinutes,
          hourlyRatePence,
          notes: emptyToNull(input.notes),
        },
      });
      return {
        entityId: created.driverId,
        after: created,
        result: { ok: true as const, id: created.id, reference: created.reference },
      };
    },
    context,
  );
}

/**
 * Enter a shift that has already been worked.
 *
 * Deliberately not `openShift` with an end date on it. Opening a shift asks
 * "may this driver clock on", whose answer is the one-open-shift rule; this
 * asks "did this happen, and has it been entered already", which is a
 * different question with a different answer. A driver on shift this
 * afternoon may perfectly well have worked last Tuesday, and refusing that
 * would make the feature useless for the drivers who work most.
 *
 * The rate is resolved at the *start* of the recorded shift, not today, so
 * entering March's work next week pays March's rate.
 */
export async function recordShift(
  input: RecordShiftInput,
  context: AuditContext,
): Promise<{ ok: true; id: string; reference: string } | (ShiftRefusal & { ok: false })> {
  const { timeZone } = await getLocaleConfig();
  const startedAt = toUTC(input.startedAt, timeZone);
  const endedAt = toUTC(input.endedAt, timeZone);

  /*
   * Every shift this driver has that could collide.
   *
   * Narrowed in SQL to the ones that could possibly overlap and then decided
   * in `shiftsOverlap`, so the rule lives in one testable place: an open
   * shift has no end for SQL to compare against, and treating "no end" as
   * "forever" is the conservative reading the pure function already holds.
   */
  const candidates = await prisma.driverShift.findMany({
    where: {
      driverId: input.driverId,
      OR: [{ endedAt: null }, { endedAt: { gt: startedAt } }],
      startedAt: { lt: endedAt },
    },
    select: { reference: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: 'asc' },
  });

  const clash =
    candidates.find((candidate) =>
      shiftsOverlap(candidate, { startedAt, endedAt }),
    ) ?? null;

  const allowed = canRecordShift(
    { startedAt, endedAt, breakMinutes: input.breakMinutes },
    { now: new Date(), clash },
  );
  if (!allowed.ok) return allowed;

  let rate = input.hourlyRatePence;
  if (rate === null) {
    const periods = await engagementPeriodsFor(input.driverId);
    rate = engagementAt(periods, startedAt)?.hourlyRatePence ?? null;
  }

  if (rate === null) {
    return {
      ok: false,
      message:
        'No hourly rate for this driver at that date. Add a hired engagement, or enter a rate for this shift.',
    };
  }

  const reference = await nextShiftReference();
  const hourlyRatePence = rate;

  return withAudit(
    'Driver',
    'update',
    async (tx) => {
      const created = await tx.driverShift.create({
        data: {
          reference,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          startedAt,
          endedAt,
          breakMinutes: input.breakMinutes,
          hourlyRatePence,
          notes: emptyToNull(input.notes),
        },
      });

      // In the same transaction as the shift: a shift that exists without its
      // jobs attached is one where every job still carries a driver fee the
      // shift is also paying.
      await attachJobsToShift(tx, {
        id: created.id,
        driverId: created.driverId,
        startedAt,
        endedAt,
      });

      return {
        entityId: created.driverId,
        after: created,
        result: { ok: true as const, id: created.id, reference: created.reference },
      };
    },
    context,
  );
}

/**
 * Put the driver's jobs from that stretch onto the shift.
 *
 * The other half of recording a shift. A shift entered after the fact covers
 * work that was booked before the shift existed, so nothing could have linked
 * the two at the time — and without the link every one of those jobs still
 * carries its own driver fee, which is then charged again as shift pay. The
 * same day costed twice, in two reports that disagree.
 *
 * Only jobs that are nobody else's. A job already on a shift is left alone
 * rather than moved: whoever put it there knew something, and silently
 * reassigning work between two drivers' pay is not a thing to do without
 * being asked.
 *
 * Cancelled jobs are skipped — a journey that did not happen was not worked,
 * whatever the driver's hours say.
 *
 * Any driver cost already recorded against an attached job is cleared and its
 * totals recomputed. Leaving it would mean a figure that is no longer counted
 * still sitting in the panel and still subtracting from that job's profit,
 * which is the worst of both readings.
 */
export async function attachJobsToShift(
  tx: Prisma.TransactionClient,
  shift: { id: string; driverId: string; startedAt: Date; endedAt: Date },
): Promise<string[]> {
  const jobs = await tx.job.findMany({
    where: {
      driverId: shift.driverId,
      shiftId: null,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      scheduledAt: { gte: shift.startedAt, lt: shift.endedAt },
    },
    select: { id: true, finance: true },
  });

  if (jobs.length === 0) return [];

  await tx.job.updateMany({
    where: { id: { in: jobs.map((job) => job.id) } },
    data: { shiftId: shift.id },
  });

  for (const job of jobs) {
    if (!job.finance) continue;

    const cleared = withoutDriverCost({
      baseFarePence: job.finance.baseFarePence,
      waitTimePence: job.finance.waitTimePence,
      extraChargesPence: job.finance.extraChargesPence,
      customerHours: decimalOrNull(job.finance.customerHours),
      customerRatePence: job.finance.customerRatePence,
      customerDays: decimalOrNull(job.finance.customerDays),
      customerDayRatePence: job.finance.customerDayRatePence,
      driverPaymentPence: job.finance.driverPaymentPence,
      fuelCostPence: job.finance.fuelCostPence,
      otherExpensesPence: job.finance.otherExpensesPence,
      driverHours: decimalOrNull(job.finance.driverHours),
      driverRatePence: job.finance.driverRatePence,
      driverDays: decimalOrNull(job.finance.driverDays),
      driverDayRatePence: job.finance.driverDayRatePence,
    });

    const totals = calculateFinance(cleared);

    await tx.jobFinance.update({
      where: { jobId: job.id },
      data: {
        driverPaymentPence: 0,
        driverHours: null,
        driverRatePence: 0,
        driverDays: null,
        driverDayRatePence: 0,
        totalCostsPence: totals.totalCostsPence,
        grossProfitPence: totals.grossProfitPence,
      },
    });
  }

  return jobs.map((job) => job.id);
}

/** A Prisma `Decimal` column as the number the finance arithmetic wants. */
function decimalOrNull(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

export async function closeShift(
  shiftId: string,
  /** The wall-clock string the form sent — converted here, see `openShift`. */
  endedAtLocal: string,
  breakMinutes: number,
  context: AuditContext,
): Promise<ShiftRefusal> {
  const { timeZone } = await getLocaleConfig();

  let endedAt: Date;
  try {
    endedAt = toUTC(endedAtLocal, timeZone);
  } catch {
    return { ok: false, message: 'That end time was not understood' };
  }

  const shift = await prisma.driverShift.findUnique({
    where: { id: shiftId },
    select: { id: true, driverId: true, startedAt: true, endedAt: true },
  });
  if (!shift) return { ok: false, message: 'That shift no longer exists' };

  const allowed = canCloseShift(
    { startedAt: shift.startedAt, endedAt: shift.endedAt, breakMinutes },
    endedAt,
  );
  if (!allowed.ok) return allowed;

  await withAudit(
    'Driver',
    'update',
    async (tx) => {
      const before = await tx.driverShift.findUniqueOrThrow({ where: { id: shiftId } });
      const after = await tx.driverShift.update({
        where: { id: shiftId },
        data: { endedAt, breakMinutes },
      });

      /*
       * Now, because only now is the stretch known. An open shift has no end
       * to measure against, so a job booked during it could only be attached
       * by hand from the booking form — and the ones nobody remembered to
       * attach are exactly the ones that would be paid for twice.
       */
      await attachJobsToShift(tx, {
        id: shiftId,
        driverId: shift.driverId,
        startedAt: shift.startedAt,
        endedAt,
      });

      return { entityId: shift.driverId, before, after, result: null };
    },
    context,
  );

  return { ok: true };
}

export async function approveShift(
  shiftId: string,
  userId: string,
  context: AuditContext,
): Promise<ShiftRefusal> {
  const shift = await prisma.driverShift.findUnique({
    where: { id: shiftId },
    select: { driverId: true, endedAt: true },
  });
  if (!shift) return { ok: false, message: 'That shift no longer exists' };
  if (!shift.endedAt) {
    return { ok: false, message: 'End the shift before approving it' };
  }

  await withAudit(
    'Driver',
    'update',
    async (tx) => {
      const before = await tx.driverShift.findUniqueOrThrow({ where: { id: shiftId } });
      const after = await tx.driverShift.update({
        where: { id: shiftId },
        data: { approvedAt: new Date(), approvedById: userId },
      });
      return { entityId: shift.driverId, before, after, result: null };
    },
    context,
  );

  return { ok: true };
}

const SHIFT_INCLUDE = {
  driver: { select: { id: true, name: true, reference: true } },
  vehicle: { select: { id: true, registration: true } },
  jobs: {
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      clientPricePence: true,
      driverPricePence: true,
      finance: true,
      stops: { select: { chargePence: true } },
      expenses: { select: { amountPence: true, borneBy: true } },
    },
  },
} as const;

export async function getShift(id: string) {
  return prisma.driverShift.findUnique({ where: { id }, include: SHIFT_INCLUDE });
}

/** A shift with its pay and profitability worked out. */
export async function getShiftWithTotals(id: string) {
  const shift = await getShift(id);
  if (!shift) return null;

  const jobs = shift.jobs.map((job) => ({
    ...job,
    economics: jobEconomics({
      finance: financeAmountsFrom(job.finance),
      clientPricePence: job.clientPricePence,
      driverPricePence: job.driverPricePence,
      stops: job.stops,
      expenses: job.expenses,
      paidByShift: true,
    }),
  }));

  const pay = shiftPayPence(shift);

  return {
    ...shift,
    jobs,
    minutes: paidMinutes(shift),
    payPence: pay,
    profit: shiftProfit(
      pay,
      jobs.map((job) => ({
        revenuePence: job.economics.totalClientPence,
        companyExpensePence: job.economics.companyExpensePence,
      })),
    ),
  };
}

export interface ShiftListFilters {
  driverId: string | null;
  openOnly: boolean;
}

export async function listShifts(
  params: { skip: number; take: number },
  filters: ShiftListFilters,
) {
  const where = {
    ...(filters.driverId ? { driverId: filters.driverId } : {}),
    ...(filters.openOnly ? { endedAt: null } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.driverShift.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: params.skip,
      take: params.take,
      include: {
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, registration: true } },
        _count: { select: { jobs: true } },
      },
    }),
    prisma.driverShift.count({ where }),
  ]);

  return {
    rows: rows.map((shift) => ({
      ...shift,
      minutes: paidMinutes(shift),
      payPence: shiftPayPence(shift),
    })),
    total,
  };
}
