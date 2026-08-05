import type { VehicleCostKind } from '@prisma/client';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { fromDateOnlyString } from './dates';
import { financeAmountsFrom, jobEconomics } from './job-finance';
import { parseMoney } from './money';
import { prisma } from './prisma';
import { rentalCharge } from './rentals';
import { shiftPayPence } from './shifts';
import { buildObjectKey, isStorageConfigured, upload } from './storage';
import { emptyToNull } from './text';
import { companyBearsCosts, serviceStatus } from './vehicle-costs';
import { defaultPnlWindow, rankByProfit, vehiclePnl } from './vehicle-pnl';

/**
 * Fleet persistence, and assembling the profit view from real records.
 *
 * The arithmetic lives in `lib/vehicle-costs.ts` and `lib/vehicle-pnl.ts`.
 * This module's job is to gather the right rows for a window and hand them
 * over — which is where the subtle mistakes live, because a job counts toward
 * a car by its *scheduled* time, a rental by its period, and a standing cost
 * by pro-rata overlap. Three different notions of "in this window".
 */

const money = z
  .string()
  .trim()
  .min(1, 'Enter the amount')
  .superRefine((value, ctx) => {
    try {
      if (parseMoney(value) <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter an amount greater than zero',
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 250.00' });
    }
  })
  .transform((value) => parseMoney(value));

const optionalInt = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().int().min(0).nullable(),
);

export const vehicleCostSchema = z.object({
  kind: z.enum([
    'SERVICE',
    'REPAIR',
    'MOT_TEST',
    'TYRES',
    'BODYWORK',
    'CLEANING',
    'INSURANCE',
    'ROAD_TAX',
    'FINANCE',
    'LEASE',
    'BREAKDOWN_COVER',
    'PARKING_PERMIT',
    'OTHER',
  ]),
  amountPence: money,
  incurredOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker'),
  supplier: z.string().trim().max(200).optional().or(z.literal('')),
  invoiceRef: z.string().trim().max(100).optional().or(z.literal('')),
  odometer: optionalInt,
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type VehicleCostInput = z.infer<typeof vehicleCostSchema>;

export const standingCostSchema = z
  .object({
    kind: z.enum([
      'INSURANCE',
      'ROAD_TAX',
      'FINANCE',
      'LEASE',
      'BREAKDOWN_COVER',
      'PARKING_PERMIT',
      'OTHER',
    ]),
    label: z.string().trim().min(1, 'Give it a name').max(200),
    amountPence: money,
    periodMonths: z.coerce
      .number()
      .int()
      .min(1, 'A period is at least one month')
      .max(120),
    startsOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker'),
    endsOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
      .optional()
      .or(z.literal('')),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  .superRefine((input, ctx) => {
    if (input.endsOn && input.endsOn <= input.startsOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsOn'],
        message: 'The end must be after the start',
      });
    }
  });

export type StandingCostInput = z.infer<typeof standingCostSchema>;

export type CostRefusal = { ok: true } | { ok: false; message: string };

/** A receipt to file against the cost. Optional throughout. */
export interface ReceiptUpload {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * Record a cost against a vehicle.
 *
 * Refused on a driver-owned car (spec 2.6.2.6): those costs belong to its
 * owner, and putting them here would both understate that car's margin and
 * overstate what the company spends.
 *
 * A cost carrying an odometer reading updates the car's current mileage, and
 * a service also moves the last-serviced marks — otherwise every service
 * would have to be entered twice.
 *
 * A receipt, when one is supplied, is stored before the transaction opens.
 * The order matters: a failed upload must not leave a row pointing at an
 * object that does not exist, and a garage invoice that silently vanished
 * would only be discovered at the VAT return.
 */
export async function recordVehicleCost(
  vehicleId: string,
  input: VehicleCostInput,
  context: AuditContext,
  receipt?: ReceiptUpload,
): Promise<CostRefusal> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { ownership: true, currentOdometer: true, registration: true },
  });
  if (!vehicle) return { ok: false, message: 'That vehicle no longer exists' };

  if (!companyBearsCosts(vehicle.ownership)) {
    return {
      ok: false,
      message: `${vehicle.registration} belongs to its driver. Its running costs are theirs, not the company's.`,
    };
  }

  const incurredOn = fromDateOnlyString(input.incurredOn);

  let receiptFileKey: string | null = null;
  if (receipt) {
    // Said plainly rather than dropping the file: the operator watched it
    // upload and would otherwise believe the receipt was filed.
    if (!isStorageConfigured()) {
      return {
        ok: false,
        message:
          'File storage is not configured, so the receipt could not be filed. Record the cost without it, or set up a Blob store first.',
      };
    }
    receiptFileKey = buildObjectKey(
      'vehicle-cost',
      vehicleId,
      receipt.fileName,
      'receipts',
    );
    await upload(receipt.buffer, receiptFileKey, receipt.mimeType);
  }

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const created = await tx.vehicleCost.create({
        data: {
          vehicleId,
          kind: input.kind,
          amountPence: input.amountPence,
          incurredOn,
          supplier: emptyToNull(input.supplier),
          invoiceRef: emptyToNull(input.invoiceRef),
          odometer: input.odometer,
          receiptFileKey,
          note: emptyToNull(input.note),
          createdById: context.userId ?? null,
        },
      });

      // Only ever forwards: a historic invoice entered late must not wind the
      // odometer back.
      const movesOdometer =
        input.odometer !== null &&
        input.odometer > (vehicle.currentOdometer ?? -1);

      if (movesOdometer || input.kind === 'SERVICE') {
        await tx.vehicle.update({
          where: { id: vehicleId },
          data: {
            ...(movesOdometer ? { currentOdometer: input.odometer } : {}),
            ...(input.kind === 'SERVICE'
              ? {
                  lastServicedOn: incurredOn,
                  ...(input.odometer !== null
                    ? { lastServiceMiles: input.odometer }
                    : {}),
                }
              : {}),
          },
        });
      }

      return { entityId: vehicleId, after: created, result: null };
    },
    context,
  );

  return { ok: true };
}

export async function recordStandingCost(
  vehicleId: string,
  input: StandingCostInput,
  context: AuditContext,
): Promise<CostRefusal> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { ownership: true, registration: true },
  });
  if (!vehicle) return { ok: false, message: 'That vehicle no longer exists' };

  if (!companyBearsCosts(vehicle.ownership)) {
    return {
      ok: false,
      message: `${vehicle.registration} belongs to its driver. The company does not carry its standing costs.`,
    };
  }

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const created = await tx.vehicleStandingCost.create({
        data: {
          vehicleId,
          kind: input.kind,
          label: input.label,
          amountPence: input.amountPence,
          periodMonths: input.periodMonths,
          startsOn: fromDateOnlyString(input.startsOn),
          endsOn: input.endsOn ? fromDateOnlyString(input.endsOn) : null,
          note: emptyToNull(input.note),
        },
      });
      return { entityId: vehicleId, after: created, result: null };
    },
    context,
  );

  return { ok: true };
}

export async function deleteVehicleCost(
  costId: string,
  context: AuditContext,
): Promise<CostRefusal> {
  const cost = await prisma.vehicleCost.findUnique({
    where: { id: costId },
    select: { vehicleId: true },
  });
  if (!cost) return { ok: false, message: 'That cost no longer exists' };

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const before = await tx.vehicleCost.findUniqueOrThrow({ where: { id: costId } });
      // Soft, like everything else — a cost that vanishes is one nobody can
      // reconcile an invoice against.
      await tx.vehicleCost.update({
        where: { id: costId },
        data: { deletedAt: new Date() },
      });
      return { entityId: cost.vehicleId, before, result: null };
    },
    context,
  );

  return { ok: true };
}

// ------------------------------------------------------------- profit view

export interface PnlWindow {
  from: Date;
  to: Date;
}

/**
 * A vehicle's profit and loss across a window.
 *
 * Three different notions of "in this window", one per source:
 * jobs by their scheduled time, rentals by the period they occupied the car,
 * and standing costs by pro-rata overlap.
 */
export async function vehicleProfit(vehicleId: string, window: PnlWindow) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: {
      id: true,
      registration: true,
      make: true,
      model: true,
      ownership: true,
      ownerDriver: { select: { id: true, name: true } },
    },
  });
  if (!vehicle) return null;

  const [jobs, rentals, shifts, oneOff, standing] = await Promise.all([
    prisma.job.findMany({
      where: {
        vehicleId,
        scheduledAt: { gte: window.from, lte: window.to },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
      select: {
        id: true,
        clientPricePence: true,
        driverPricePence: true,
        shiftId: true,
        finance: true,
        stops: { select: { chargePence: true } },
        expenses: { select: { amountPence: true, borneBy: true } },
      },
    }),
    prisma.vehicleRental.findMany({
      where: {
        vehicleId,
        status: { not: 'CANCELLED' },
        startAt: { lte: window.to },
      },
      select: {
        startAt: true,
        endAt: true,
        returnedAt: true,
        rateType: true,
        ratePence: true,
        damageChargePence: true,
      },
    }),
    prisma.driverShift.findMany({
      where: {
        vehicleId,
        startedAt: { gte: window.from, lte: window.to },
        endedAt: { not: null },
      },
      select: { startedAt: true, endedAt: true, breakMinutes: true, hourlyRatePence: true },
    }),
    prisma.vehicleCost.findMany({
      where: { vehicleId, incurredOn: { gte: window.from, lte: window.to } },
      select: { amountPence: true },
    }),
    prisma.vehicleStandingCost.findMany({
      where: { vehicleId },
      select: {
        amountPence: true,
        periodMonths: true,
        startsOn: true,
        endsOn: true,
      },
    }),
  ]);

  const jobContributions = jobs.map((job) => {
    const economics = jobEconomics({
      finance: financeAmountsFrom(job.finance),
      clientPricePence: job.clientPricePence,
      driverPricePence: job.driverPricePence,
      stops: job.stops,
      expenses: job.expenses,
      paidByShift: Boolean(job.shiftId),
    });
    return {
      revenuePence: economics.totalClientPence,
      // A shift-paid job contributes no per-job driver cost; the shift below
      // carries it instead. Counting both would pay the driver twice.
      driverPayPence: job.shiftId ? 0 : (job.driverPricePence ?? 0),
      companyExpensePence: economics.companyExpensePence,
    };
  });

  const rentalRevenuePence = rentals.reduce(
    (total, rental) => total + rentalCharge(rental).totalPence,
    0,
  );

  const shiftPay = shifts.reduce(
    (total, shift) => total + (shiftPayPence(shift) ?? 0),
    0,
  );

  return {
    vehicle,
    pnl: vehiclePnl({
      ownership: vehicle.ownership,
      jobs: jobContributions,
      rentalRevenuePence,
      shiftPayPence: shiftPay,
      oneOffCostPence: oneOff.reduce((total, cost) => total + cost.amountPence, 0),
      standingCosts: standing,
      from: window.from,
      to: window.to,
    }),
    jobCount: jobs.length,
    rentalCount: rentals.length,
  };
}

/** Every active vehicle's profit, worst first. */
export async function fleetProfit(window: PnlWindow = defaultPnlWindow()) {
  const vehicles = await prisma.vehicle.findMany({
    where: { status: { not: 'RETIRED' } },
    select: { id: true },
    take: 500,
  });

  const results = [];
  for (const { id } of vehicles) {
    const result = await vehicleProfit(id, window);
    if (result) results.push(result);
  }

  return rankByProfit(results);
}

export async function getVehicleCosts(vehicleId: string) {
  const [costs, standing, vehicle] = await Promise.all([
    prisma.vehicleCost.findMany({
      where: { vehicleId },
      orderBy: { incurredOn: 'desc' },
      take: 200,
    }),
    prisma.vehicleStandingCost.findMany({
      where: { vehicleId },
      orderBy: { startsOn: 'desc' },
    }),
    prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        lastServicedOn: true,
        lastServiceMiles: true,
        currentOdometer: true,
        serviceEveryMonths: true,
        serviceEveryMiles: true,
      },
    }),
  ]);

  return {
    costs,
    standing,
    service: vehicle ? serviceStatus(vehicle) : null,
  };
}

/** One cost, for the receipt link. Deleted costs keep theirs — the receipt is
 *  the evidence for a payment that still happened. */
export async function getVehicleCost(costId: string) {
  return prisma.vehicleCost.findUnique({
    where: { id: costId },
    select: { id: true, vehicleId: true, receiptFileKey: true },
  });
}

export const COST_KINDS: VehicleCostKind[] = [
  'SERVICE',
  'REPAIR',
  'MOT_TEST',
  'TYRES',
  'BODYWORK',
  'CLEANING',
  'BREAKDOWN_COVER',
  'PARKING_PERMIT',
  'OTHER',
];
