import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { engagementAt, type EngagementPeriod } from './engagement';
import { prisma } from './prisma';
import { formatReference } from './references';
import {
  canCloseShift,
  canOpenShift,
  paidMinutes,
  shiftPayPence,
  shiftProfit,
  SHIFT_REFERENCE_PAD,
  SHIFT_REFERENCE_PREFIX,
  type ShiftRefusal,
} from './shifts';
import { financeAmountsFrom, jobEconomics } from './job-finance';
import { emptyToNull } from './text';

/**
 * Persistence for shifts. The arithmetic lives in `lib/shifts.ts`; this is
 * the part that touches Postgres and writes the audit trail.
 */

export const openShiftSchema = z.object({
  driverId: z.string().trim().min(1, 'Choose a driver'),
  vehicleId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  startedAt: z
    .string()
    .trim()
    .min(1, 'Enter when the shift started')
    .transform((value) => new Date(value)),
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
  const existing = await prisma.driverShift.findFirst({
    where: { driverId: input.driverId, endedAt: null },
    select: { reference: true, startedAt: true },
  });

  const allowed = canOpenShift(existing);
  if (!allowed.ok) return allowed;

  let rate = input.hourlyRatePence;
  if (rate === null) {
    const periods = await engagementPeriodsFor(input.driverId);
    rate = engagementAt(periods, input.startedAt)?.hourlyRatePence ?? null;
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
          startedAt: input.startedAt,
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

export async function closeShift(
  shiftId: string,
  endedAt: Date,
  breakMinutes: number,
  context: AuditContext,
): Promise<ShiftRefusal> {
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
