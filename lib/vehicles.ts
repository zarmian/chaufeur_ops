import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import {
  vehicleComplianceAt,
  worstLevel,
  type ComplianceLevel,
  type ComplianceThresholds,
} from './compliance';
import { fromDateOnlyString } from './dates';
import type { ListParams } from './list-params';
import { parseMoney } from './money';
import { prisma } from './prisma';
import { emptyToNull, normaliseRegistration, tidy } from './text';

/**
 * Vehicles — the fleet, and whether each car is legal to put on a job.
 *
 * The legacy system stored MOT, insurance and V5 as images with no dates, so
 * nothing could warn that anything was lapsing. The expiry columns here are
 * the fix; the scanned documents are evidence attached alongside them.
 */

const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
  .optional()
  .or(z.literal(''));

// `z.coerce.number()` turns '' into 0, which would record a car with no
// odometer as one that has never moved. Blanks become null before coercion.
const optionalInt = z.preprocess(
  (value) =>
    value === '' || value === null || value === undefined ? null : value,
  z.coerce.number().int().min(0).max(2_000_000).nullable(),
);

export const vehicleSchema = z.object({
  registration: z
    .string()
    .trim()
    .min(1, 'Enter the registration')
    .max(20, 'That registration is too long'),
  make: z.string().trim().min(1, 'Enter the make').max(60),
  model: z.string().trim().min(1, 'Enter the model').max(60),
  variant: z.string().trim().max(60).optional().or(z.literal('')),
  vehicleClass: z.enum([
    'SALOON',
    'EXECUTIVE',
    'LUXURY',
    'MPV',
    'SUV',
    'ELECTRIC_EXECUTIVE',
  ]),
  colour: z.string().trim().max(40).optional().or(z.literal('')),
  seats: z.coerce.number().int().min(1).max(16).default(4),
  phvLicenceNumber: z.string().trim().max(60).optional().or(z.literal('')),
  phvLicenceExpiry: optionalDate,
  motExpiry: optionalDate,
  insuranceExpiry: optionalDate,
  insurancePolicyNo: z.string().trim().max(60).optional().or(z.literal('')),
  // Printed on a hire agreement, which has to identify the car precisely
  // enough to be enforceable.
  insurerName: z.string().trim().max(120).optional().or(z.literal('')),
  chassisNumber: z.string().trim().max(40).optional().or(z.literal('')),
  firstRegisteredOn: z.string().trim().optional().or(z.literal('')),
  valuePence: z.string().trim().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'OFF_ROAD', 'RETIRED']),

  // Phase 2.6. Defaulted so an existing record saved through an older form
  // keeps its meaning rather than silently becoming a company car.
  ownership: z
    .enum(['OWNED', 'FINANCED', 'LEASED', 'DRIVER_OWNED'])
    .default('DRIVER_OWNED'),
  ownerDriverId: z.string().trim().optional().or(z.literal('')),
  acquiredOn: optionalDate,
  disposedOn: optionalDate,
  purchasePrice: z
    .string()
    .trim()
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      try {
        parseMoney(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter an amount like 34500.00, or leave it blank',
        });
      }
    }),
  currentOdometer: optionalInt,
  lastServicedOn: optionalDate,
  lastServiceMiles: optionalInt,
  serviceEveryMonths: optionalInt,
  serviceEveryMiles: optionalInt,
});

export type VehicleInput = z.infer<typeof vehicleSchema>;

const toDate = (value: string | undefined) =>
  value && value !== '' ? fromDateOnlyString(value) : null;

function toData(input: VehicleInput) {
  return {
    registration: tidy(input.registration).toUpperCase(),
    normalisedRegistration: normaliseRegistration(input.registration),
    make: tidy(input.make),
    model: tidy(input.model),
    variant: emptyToNull(input.variant),
    vehicleClass: input.vehicleClass,
    colour: emptyToNull(input.colour),
    seats: input.seats,
    phvLicenceNumber: emptyToNull(input.phvLicenceNumber),
    phvLicenceExpiry: toDate(input.phvLicenceExpiry),
    motExpiry: toDate(input.motExpiry),
    insuranceExpiry: toDate(input.insuranceExpiry),
    insurancePolicyNo: emptyToNull(input.insurancePolicyNo),
    insurerName: emptyToNull(input.insurerName),
    chassisNumber: emptyToNull(input.chassisNumber),
    firstRegisteredOn: fromDateOnlyString(input.firstRegisteredOn ?? ''),
    valuePence: input.valuePence ? parseMoney(input.valuePence) : null,
    status: input.status,

    ownership: input.ownership,
    // An owner only means anything on a driver's own car. Keeping one against
    // a company car would leave the record claiming both.
    ownerDriverId:
      input.ownership === 'DRIVER_OWNED'
        ? emptyToNull(input.ownerDriverId)
        : null,
    acquiredOn: toDate(input.acquiredOn),
    disposedOn: toDate(input.disposedOn),
    purchasePricePence: input.purchasePrice?.trim()
      ? parseMoney(input.purchasePrice)
      : null,
    currentOdometer: input.currentOdometer,
    lastServicedOn: toDate(input.lastServicedOn),
    lastServiceMiles: input.lastServiceMiles,
    serviceEveryMonths: input.serviceEveryMonths,
    serviceEveryMiles: input.serviceEveryMiles,
  };
}

export class DuplicateRegistrationError extends Error {
  constructor(
    readonly existingId: string,
    readonly existingRegistration: string,
  ) {
    // Names the existing vehicle, so the operator can go and look at it
    // rather than guessing which record already holds the plate.
    super(
      `${existingRegistration} is already on the fleet. Open that record instead of creating a second one.`,
    );
    this.name = 'DuplicateRegistrationError';
  }
}

async function assertRegistrationFree(registration: string, excludeId?: string) {
  const existing = await prisma.vehicle.findFirst({
    where: {
      normalisedRegistration: normaliseRegistration(registration),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, registration: true },
  });
  if (existing) {
    throw new DuplicateRegistrationError(existing.id, existing.registration);
  }
}

export interface VehicleListFilters {
  status: string | null;
  vehicleClass: string | null;
  compliance: string | null;
  ownership: string | null;
  archived: boolean;
}

export async function listVehicles(
  params: ListParams,
  filters: VehicleListFilters,
  thresholds: ComplianceThresholds,
  now = new Date(),
) {
  const where = {
    ...(filters.archived ? { deletedAt: { not: null } } : {}),
    ...(filters.status
      ? { status: filters.status as VehicleInput['status'] }
      : {}),
    ...(filters.vehicleClass
      ? { vehicleClass: filters.vehicleClass as VehicleInput['vehicleClass'] }
      : {}),
    ...(filters.ownership
      ? { ownership: filters.ownership as VehicleInput['ownership'] }
      : {}),
    ...(params.q
      ? {
          OR: [
            {
              normalisedRegistration: {
                contains: normaliseRegistration(params.q),
              },
            },
            { make: { contains: params.q, mode: 'insensitive' as const } },
            { model: { contains: params.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const select = {
    id: true,
    registration: true,
    make: true,
    model: true,
    variant: true,
    vehicleClass: true,
    seats: true,
    status: true,
    deletedAt: true,
    motExpiry: true,
    insuranceExpiry: true,
    phvLicenceExpiry: true,
    ownership: true,
    drivers: { select: { id: true, name: true }, take: 2 },
  };

  // Compliance is derived, not stored, so filtering on it has to happen after
  // the rows come back. Without a compliance filter the query paginates in
  // SQL as normal; with one it fetches the (bounded) matching set and pages
  // in memory. The fleet is ~195 vehicles, so that is a fair trade for not
  // duplicating the expiry rules into SQL where they could drift.
  if (filters.compliance) {
    const all = await prisma.vehicle.findMany({
      where,
      orderBy: { registration: params.dir },
      select,
    });
    const decorated = all.map((vehicle) => ({
      ...vehicle,
      compliance: vehicleComplianceAt(vehicle, now, thresholds),
    }));
    const matching = decorated.filter(
      (v) => v.compliance.level === filters.compliance,
    );
    return {
      rows: matching.slice(params.skip, params.skip + params.take),
      total: matching.length,
    };
  }

  const [rows, total] = await Promise.all([
    prisma.vehicle.findMany({
      where,
      orderBy: { registration: params.dir },
      skip: params.skip,
      take: params.take,
      select,
    }),
    prisma.vehicle.count({ where }),
  ]);

  return {
    rows: rows.map((vehicle) => ({
      ...vehicle,
      compliance: vehicleComplianceAt(vehicle, now, thresholds),
    })),
    total,
  };
}

export async function getVehicle(id: string) {
  return prisma.vehicle.findUnique({
    where: { id },
    include: {
      drivers: { select: { id: true, name: true, reference: true } },
      ownerDriver: { select: { id: true, name: true, reference: true } },
      documents: {
        orderBy: { uploadedAt: 'desc' },
        where: { supersededBy: null },
      },
    },
  });
}

/** Drivers offered as the owner of a driver-owned car. */
export async function listDriverOptions() {
  return prisma.driver.findMany({
    where: { status: { not: 'INACTIVE' } },
    select: { id: true, name: true, reference: true },
    orderBy: { name: 'asc' },
    take: 1000,
  });
}

export async function createVehicle(
  input: VehicleInput,
  context: AuditContext,
): Promise<{ id: string }> {
  await assertRegistrationFree(input.registration);
  return withAudit(
    'Vehicle',
    'create',
    async (tx) => {
      const created = await tx.vehicle.create({ data: toData(input) });
      return { entityId: created.id, after: created, result: { id: created.id } };
    },
    context,
  );
}

export async function updateVehicle(
  id: string,
  input: VehicleInput,
  context: AuditContext,
): Promise<{ id: string }> {
  await assertRegistrationFree(input.registration, id);
  return withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const before = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      const after = await tx.vehicle.update({ where: { id }, data: toData(input) });
      return { entityId: id, before, after, result: { id } };
    },
    context,
  );
}

export async function archiveVehicle(
  id: string,
  context: AuditContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const futureJobs = await prisma.job.count({
    where: {
      vehicleId: id,
      scheduledAt: { gte: new Date() },
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
  });

  if (futureJobs > 0) {
    return {
      ok: false,
      reason: `This vehicle is on ${futureJobs} upcoming job${
        futureJobs === 1 ? '' : 's'
      }. Reassign or cancel them first.`,
    };
  }

  await withAudit(
    'Vehicle',
    'delete',
    async (tx) => {
      const before = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      await tx.vehicle.update({ where: { id }, data: { deletedAt: new Date() } });
      return { entityId: id, before, result: null };
    },
    context,
  );

  return { ok: true };
}

/** Fleet-wide compliance summary, for the dashboard tile. */
export function summariseLevels(
  levels: ComplianceLevel[],
): Record<ComplianceLevel, number> & { worst: ComplianceLevel } {
  const counts: Record<ComplianceLevel, number> = {
    ok: 0,
    warning: 0,
    critical: 0,
    expired: 0,
    unknown: 0,
  };
  for (const level of levels) counts[level] += 1;
  return { ...counts, worst: worstLevel(levels) };
}
