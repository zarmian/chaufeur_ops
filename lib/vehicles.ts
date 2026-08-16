import type { Prisma } from '@prisma/client';
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
import { parseMoney, tryParseMoney } from './money';
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

/**
 * A typed amount, rejected here rather than at `parseMoney`.
 *
 * `parseMoney` throws, and a throw out of a Server Action reaches the route's
 * error boundary as "this page could not be loaded" — which tells the operator
 * the page is broken when in fact one field is. Validating in the schema turns
 * the same mistake into a message under the box it belongs to.
 */
const optionalMoney = (hint: string) =>
  z
    .string()
    .trim()
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      if (tryParseMoney(value) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Enter an amount like ${hint}, or leave it blank`,
        });
      }
    });

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
  firstRegisteredOn: optionalDate,
  valuePence: optionalMoney('143000.00'),
  status: z.enum(['ACTIVE', 'OFF_ROAD', 'RETIRED']),

  // Phase 2.6. Defaulted so an existing record saved through an older form
  // keeps its meaning rather than silently becoming a company car.
  ownership: z
    .enum(['OWNED', 'FINANCED', 'LEASED', 'DRIVER_OWNED'])
    .default('DRIVER_OWNED'),
  ownerDriverId: z.string().trim().optional().or(z.literal('')),
  acquiredOn: optionalDate,
  disposedOn: optionalDate,
  purchasePrice: optionalMoney('34500.00'),

  /**
   * The agreement on a financed or leased car — spec 2.6.
   *
   * A lease has no purchase price. What it has is a payment, every month, for
   * a term, and that payment is the whole cost of holding the car — asking for
   * a purchase price instead left the single largest running cost on the
   * fleet unrecorded, so every leased car reported a profit it was not making.
   *
   * These are not columns on `Vehicle`. They read and write the vehicle's open
   * `VehicleStandingCost` of kind FINANCE or LEASE, which is what the
   * per-vehicle P&L already accrues — one record of the payment, not two that
   * can disagree.
   */
  financePayment: optionalMoney('750.00'),
  financePeriodMonths: optionalInt,
  financeStartsOn: optionalDate,
  financeEndsOn: optionalDate,
  financeProvider: z.string().trim().max(120).optional().or(z.literal('')),
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
    // Through `toDate`, like every other date here. Called directly it threw
    // a RangeError on a blank — and since almost no car has a first-registered
    // date recorded, saving *any* vehicle blew up with "this page could not be
    // loaded", which reads as the page being broken rather than the date.
    firstRegisteredOn: toDate(input.firstRegisteredOn),
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

/** The kind of standing cost a given ownership implies, if any. */
export function financeCostKind(
  ownership: VehicleInput['ownership'],
): 'FINANCE' | 'LEASE' | null {
  if (ownership === 'FINANCED') return 'FINANCE';
  if (ownership === 'LEASED') return 'LEASE';
  return null;
}

/**
 * The agreement currently running on a car.
 *
 * "Open" means it has not ended yet. A car that was leased last year and is
 * now owned still has that lease on file — the months it covered are real
 * cost, and deleting it would rewrite last year's profit — so what the form
 * edits is only the agreement still in force.
 */
export async function openFinanceAgreement(vehicleId: string, at = new Date()) {
  return prisma.vehicleStandingCost.findFirst({
    where: {
      vehicleId,
      kind: { in: ['FINANCE', 'LEASE'] },
      OR: [{ endsOn: null }, { endsOn: { gte: at } }],
    },
    orderBy: { startsOn: 'desc' },
  });
}

/**
 * Keep the finance or lease payment in step with the ownership.
 *
 * Three cases, and the third is the one worth being careful about:
 *
 * - Financed or leased, with a payment: create the standing cost, or update
 *   the one already running.
 * - Financed or leased, with no payment typed: leave whatever is there. A
 *   blank field means "not stated", not "the payment is nothing", and the
 *   operator who saves an unrelated field should not silently drop the cost.
 * - No longer financed or leased: **close** the agreement at today's date
 *   rather than delete it. A car leased January to June and bought in July
 *   really did cost six months of lease payments, and a P&L run over that
 *   period has to keep saying so.
 */
async function syncFinanceAgreement(
  tx: Prisma.TransactionClient,
  vehicleId: string,
  input: VehicleInput,
  at = new Date(),
): Promise<void> {
  const kind = financeCostKind(input.ownership);

  const existing = await tx.vehicleStandingCost.findFirst({
    where: {
      vehicleId,
      kind: { in: ['FINANCE', 'LEASE'] },
      OR: [{ endsOn: null }, { endsOn: { gte: at } }],
    },
    orderBy: { startsOn: 'desc' },
  });

  if (!kind) {
    if (existing) {
      await tx.vehicleStandingCost.update({
        where: { id: existing.id },
        data: { endsOn: startOfDay(at) },
      });
    }
    return;
  }

  const amountPence = input.financePayment?.trim()
    ? parseMoney(input.financePayment)
    : null;
  if (amountPence === null && !existing) return;

  const label = input.financeProvider?.trim()
    ? `${kind === 'LEASE' ? 'Lease' : 'Finance'} — ${tidy(input.financeProvider)}`
    : kind === 'LEASE'
      ? 'Lease payment'
      : 'Finance payment';

  const data = {
    kind,
    label,
    periodMonths: input.financePeriodMonths ?? existing?.periodMonths ?? 1,
    // Dated from when the agreement started, so the P&L accrues it across the
    // months it actually covered rather than from whenever somebody typed it.
    startsOn:
      toDate(input.financeStartsOn) ??
      existing?.startsOn ??
      toDate(input.acquiredOn) ??
      startOfDay(at),
    // Blank means the agreement is still running, which is the normal case.
    endsOn: toDate(input.financeEndsOn),
  };

  if (existing) {
    await tx.vehicleStandingCost.update({
      where: { id: existing.id },
      data: { ...data, ...(amountPence === null ? {} : { amountPence }) },
    });
    return;
  }

  await tx.vehicleStandingCost.create({
    data: { ...data, vehicleId, amountPence: amountPence ?? 0 },
  });
}

/** Midnight UTC, matching the `@db.Date` columns these dates land in. */
function startOfDay(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
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
      await syncFinanceAgreement(tx, created.id, input);
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
      await syncFinanceAgreement(tx, id, input);
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
