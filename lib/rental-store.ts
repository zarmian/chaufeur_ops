import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { parseMoney } from './money';
import { prisma } from './prisma';
import { formatReference } from './references';
import {
  DEFAULT_CHECKLIST_ITEMS,
  findRentalOverlap,
  rentalBalance,
  RENTAL_REFERENCE_PAD,
  RENTAL_REFERENCE_PREFIX,
  type RentalRefusal,
} from './rentals';
import { emptyToNull } from './text';

/**
 * Persistence for rentals. The charging rules live in `lib/rentals.ts`.
 *
 * Rentals are audited as `Vehicle` changes: the asset is the thing whose
 * history someone will want to reconstruct — where was this car in March, and
 * who had it.
 */

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
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 80.00' });
    }
  })
  .transform((value) => parseMoney(value));

const optionalInt = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().int().min(0).nullable(),
);

export const rentalSchema = z
  .object({
    vehicleId: z.string().trim().min(1, 'Choose a vehicle'),
    driverId: z.string().trim().min(1, 'Choose who is renting it'),
    startAt: z.string().trim().min(1, 'Enter when it goes out'),
    endAt: z.string().trim().min(1, 'Enter when it is due back'),
    rateType: z.enum(['HOURLY', 'DAILY', 'WEEKLY']),
    ratePence: money,
    depositPence: money,
    mileageOut: optionalInt,
    fuelOutPct: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? null : value),
      z.coerce.number().int().min(0).max(100).nullable(),
    ),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  .superRefine((input, ctx) => {
    if (new Date(input.endAt).getTime() <= new Date(input.startAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endAt'],
        message: 'The return must be after the collection',
      });
    }
    if (input.ratePence <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ratePence'],
        message: 'Enter the rate — a rental with no rate earns nothing',
      });
    }
  });

export type RentalInput = z.infer<typeof rentalSchema>;

async function nextRentalReference(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING(reference FROM ${`^${RENTAL_REFERENCE_PREFIX}-(\\d+)$`}) AS INTEGER)) AS max
    FROM "VehicleRental"
    WHERE reference ~ ${`^${RENTAL_REFERENCE_PREFIX}-\\d+$`}
  `;
  return formatReference(
    RENTAL_REFERENCE_PREFIX,
    (rows[0]?.max ?? 0) + 1,
    RENTAL_REFERENCE_PAD,
  );
}

/**
 * Book a rental.
 *
 * Refuses a car already spoken for in that period. Double-booking a physical
 * asset is not something to warn about and allow — there is only one car.
 */
export async function createRental(
  input: RentalInput,
  context: AuditContext,
): Promise<{ ok: true; id: string; reference: string } | (RentalRefusal & { ok: false })> {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);

  const existing = await prisma.vehicleRental.findMany({
    where: { vehicleId: input.vehicleId, status: { not: 'CANCELLED' } },
    select: {
      id: true,
      reference: true,
      startAt: true,
      endAt: true,
      returnedAt: true,
      status: true,
    },
  });

  const clash = findRentalOverlap({ startAt, endAt }, existing);
  if (clash) {
    return {
      ok: false,
      message: `That vehicle is already on rental ${clash.reference} for part of this period`,
      rentalReference: clash.reference,
    };
  }

  const reference = await nextRentalReference();

  return withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const created = await tx.vehicleRental.create({
        data: {
          reference,
          vehicleId: input.vehicleId,
          driverId: input.driverId,
          startAt,
          endAt,
          rateType: input.rateType,
          ratePence: input.ratePence,
          depositPence: input.depositPence,
          mileageOut: input.mileageOut,
          fuelOutPct: input.fuelOutPct,
          notes: emptyToNull(input.notes),
          createdById: context.userId ?? null,
        },
      });

      // The collection checklist is written now, so the handover has
      // something to fill in rather than someone having to remember the list.
      await tx.rentalChecklistItem.createMany({
        data: DEFAULT_CHECKLIST_ITEMS.map((label) => ({
          rentalId: created.id,
          phase: 'OUT' as const,
          label,
        })),
      });

      return {
        entityId: created.vehicleId,
        after: created,
        result: { ok: true as const, id: created.id, reference: created.reference },
      };
    },
    context,
  );
}

export const returnSchema = z.object({
  returnedAt: z.string().trim().min(1, 'Enter when it came back'),
  mileageIn: optionalInt,
  fuelInPct: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : value),
    z.coerce.number().int().min(0).max(100).nullable(),
  ),
  damageNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  damageChargePence: money,
});

export type ReturnInput = z.infer<typeof returnSchema>;

/**
 * Take a car back.
 *
 * Writes the return-phase checklist at the same time, so collection and
 * return are recorded against the same list and can be compared line by line.
 */
export async function returnRental(
  rentalId: string,
  input: ReturnInput,
  context: AuditContext,
): Promise<RentalRefusal> {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: { id: true, vehicleId: true, startAt: true, status: true },
  });
  if (!rental) return { ok: false, message: 'That rental no longer exists' };
  if (rental.status === 'RETURNED') {
    return { ok: false, message: 'That car has already been booked back in' };
  }
  if (rental.status === 'CANCELLED') {
    return { ok: false, message: 'That rental was cancelled' };
  }

  const returnedAt = new Date(input.returnedAt);
  if (returnedAt.getTime() < rental.startAt.getTime()) {
    return { ok: false, message: 'A car cannot come back before it went out' };
  }

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const before = await tx.vehicleRental.findUniqueOrThrow({ where: { id: rentalId } });
      const after = await tx.vehicleRental.update({
        where: { id: rentalId },
        data: {
          returnedAt,
          mileageIn: input.mileageIn,
          fuelInPct: input.fuelInPct,
          damageNotes: emptyToNull(input.damageNotes),
          damageChargePence: input.damageChargePence,
          status: 'RETURNED',
        },
      });

      const alreadyChecked = await tx.rentalChecklistItem.count({
        where: { rentalId, phase: 'IN' },
      });
      if (alreadyChecked === 0) {
        await tx.rentalChecklistItem.createMany({
          data: DEFAULT_CHECKLIST_ITEMS.map((label) => ({
            rentalId,
            phase: 'IN' as const,
            label,
          })),
        });
      }

      return { entityId: rental.vehicleId, before, after, result: null };
    },
    context,
  );

  return { ok: true };
}

export async function recordRentalPayment(
  rentalId: string,
  amountPence: number,
  paidAt: Date,
  context: AuditContext,
  options: { method?: string | null; reference?: string | null } = {},
): Promise<RentalRefusal> {
  if (amountPence <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero' };
  }

  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: { vehicleId: true },
  });
  if (!rental) return { ok: false, message: 'That rental no longer exists' };

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const created = await tx.rentalPayment.create({
        data: {
          rentalId,
          amountPence,
          paidAt,
          method: (options.method as never) ?? null,
          reference: emptyToNull(options.reference ?? null),
        },
      });
      return { entityId: rental.vehicleId, after: created, result: null };
    },
    context,
  );

  return { ok: true };
}

const RENTAL_INCLUDE = {
  vehicle: { select: { id: true, registration: true, make: true, model: true } },
  driver: { select: { id: true, name: true, reference: true, phone: true } },
  payments: { orderBy: { paidAt: 'desc' } },
  checks: { orderBy: { label: 'asc' } },
} as const;

export async function getRental(id: string) {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id },
    include: RENTAL_INCLUDE,
  });
  if (!rental) return null;
  return { ...rental, balance: rentalBalance(rental, rental.payments) };
}

export interface RentalListFilters {
  status: string | null;
  vehicleId: string | null;
  driverId: string | null;
  arrearsOnly: boolean;
}

export async function listRentals(
  params: { skip: number; take: number },
  filters: RentalListFilters,
) {
  const where = {
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
    ...(filters.driverId ? { driverId: filters.driverId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.vehicleRental.findMany({
      where,
      orderBy: { startAt: 'desc' },
      // Arrears is derived from payments, so it cannot be a SQL filter without
      // duplicating the charging rules into the database where they would
      // drift. The fleet is small enough that paging the matched set in
      // memory is the honest trade — the same one listVehicles makes.
      ...(filters.arrearsOnly ? {} : { skip: params.skip, take: params.take }),
      include: {
        vehicle: { select: { id: true, registration: true } },
        driver: { select: { id: true, name: true } },
        payments: { select: { amountPence: true } },
      },
    }),
    prisma.vehicleRental.count({ where }),
  ]);

  const decorated = rows.map((rental) => ({
    ...rental,
    balance: rentalBalance(rental, rental.payments),
  }));

  if (!filters.arrearsOnly) return { rows: decorated, total };

  const matching = decorated.filter((rental) => rental.balance.inArrears);
  return {
    rows: matching.slice(params.skip, params.skip + params.take),
    total: matching.length,
  };
}

/** Total owed across every open rental — the arrears figure for the dashboard. */
export async function totalRentalArrears(): Promise<{
  count: number;
  pence: number;
}> {
  const rentals = await prisma.vehicleRental.findMany({
    where: { status: { in: ['BOOKED', 'ACTIVE', 'RETURNED'] } },
    include: { payments: { select: { amountPence: true } } },
  });

  const owing = rentals
    .map((rental) => rentalBalance(rental, rental.payments))
    .filter((balance) => balance.inArrears);

  return {
    count: owing.length,
    pence: owing.reduce((total, balance) => total + balance.balancePence, 0),
  };
}
