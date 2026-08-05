import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import {
  combinedComplianceAt,
  type ComplianceThresholds,
} from './compliance';
import { fromDateOnlyString } from './dates';
import type { ListParams } from './list-params';
import { prisma } from './prisma';
import { withDriverReference } from './references';
import { emptyToNull, normalisePhone, tidy } from './text';

/**
 * Drivers.
 *
 * Drivers are not users: they have no dashboard login and reach the system
 * only through the Telegram bot in Phase 5. What lives here is the record the
 * operator keeps about them — identity, licensing, and which car they drive.
 */

const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
  .optional()
  .or(z.literal(''));

export const driverSchema = z.object({
  name: z.string().trim().min(1, 'Enter the driver name').max(200),
  phone: z.string().trim().min(1, 'Enter a phone number').max(50),
  email: z
    .string()
    .trim()
    .email('Enter a valid email address')
    .optional()
    .or(z.literal('')),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  dvlaLicenceNumber: z.string().trim().max(60).optional().or(z.literal('')),
  dvlaLicenceExpiry: optionalDate,
  phvBadgeNumber: z.string().trim().max(60).optional().or(z.literal('')),
  phvBadgeExpiry: optionalDate,
  phvIssuingAuthority: z.string().trim().max(120).optional().or(z.literal('')),
  assignedVehicleId: z.string().trim().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type DriverInput = z.infer<typeof driverSchema>;

const toDate = (value: string | undefined) =>
  value && value !== '' ? fromDateOnlyString(value) : null;

function toData(input: DriverInput) {
  return {
    name: tidy(input.name),
    phone: tidy(input.phone),
    // Written on every save, not only on import: a driver added by hand and
    // one loaded from a spreadsheet have to be the same record when the same
    // file is imported again.
    normalisedPhone: normalisePhone(input.phone),
    email: emptyToNull(input.email)?.toLowerCase() ?? null,
    address: emptyToNull(input.address),
    dvlaLicenceNumber: emptyToNull(input.dvlaLicenceNumber),
    dvlaLicenceExpiry: toDate(input.dvlaLicenceExpiry),
    phvBadgeNumber: emptyToNull(input.phvBadgeNumber),
    phvBadgeExpiry: toDate(input.phvBadgeExpiry),
    phvIssuingAuthority: emptyToNull(input.phvIssuingAuthority),
    assignedVehicleId: emptyToNull(input.assignedVehicleId),
    status: input.status,
    notes: emptyToNull(input.notes),
  };
}

export interface DriverListFilters {
  status: string | null;
  compliance: string | null;
  archived: boolean;
}

const DRIVER_SELECT = {
  id: true,
  reference: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  deletedAt: true,
  dvlaLicenceExpiry: true,
  phvBadgeExpiry: true,
  telegramChatId: true,
  assignedVehicle: {
    select: {
      id: true,
      registration: true,
      motExpiry: true,
      insuranceExpiry: true,
      phvLicenceExpiry: true,
    },
  },
} as const;

export async function listDrivers(
  params: ListParams,
  filters: DriverListFilters,
  thresholds: ComplianceThresholds,
  now = new Date(),
) {
  const where = {
    ...(filters.archived ? { deletedAt: { not: null } } : {}),
    ...(filters.status
      ? { status: filters.status as DriverInput['status'] }
      : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: 'insensitive' as const } },
            { reference: { contains: params.q, mode: 'insensitive' as const } },
            { phone: { contains: normalisePhone(params.q) } },
            { phone: { contains: params.q } },
          ],
        }
      : {}),
  };

  const decorate = <T extends { assignedVehicle: unknown }>(driver: T) => ({
    ...driver,
    // Spans the driver *and* the car they would drive: a valid badge in an
    // uninsured vehicle is still not a job that can go out.
    compliance: combinedComplianceAt(
      driver as never,
      (driver.assignedVehicle as never) ?? null,
      now,
      thresholds,
    ),
  });

  if (filters.compliance) {
    const all = await prisma.driver.findMany({
      where,
      orderBy: { name: params.dir },
      select: DRIVER_SELECT,
    });
    const matching = all
      .map(decorate)
      .filter((d) => d.compliance.level === filters.compliance);
    return {
      rows: matching.slice(params.skip, params.skip + params.take),
      total: matching.length,
    };
  }

  const [rows, total] = await Promise.all([
    prisma.driver.findMany({
      where,
      orderBy: { name: params.dir },
      skip: params.skip,
      take: params.take,
      select: DRIVER_SELECT,
    }),
    prisma.driver.count({ where }),
  ]);

  return { rows: rows.map(decorate), total };
}

export async function getDriver(id: string) {
  return prisma.driver.findUnique({
    where: { id },
    include: {
      assignedVehicle: true,
      documents: {
        where: { supersededBy: null },
        orderBy: { uploadedAt: 'desc' },
      },
    },
  });
}

/**
 * Other active drivers already assigned this vehicle.
 *
 * A warning, not a block — relief drivers sharing a car is legitimate, and
 * an owner-driver fleet still has cars covered while someone is on holiday.
 */
export async function findVehicleSharers(
  vehicleId: string,
  excludeDriverId?: string,
): Promise<Array<{ id: string; name: string; reference: string }>> {
  if (!vehicleId) return [];
  return prisma.driver.findMany({
    where: {
      assignedVehicleId: vehicleId,
      status: 'ACTIVE',
      ...(excludeDriverId ? { id: { not: excludeDriverId } } : {}),
    },
    select: { id: true, name: true, reference: true },
    take: 5,
  });
}

/** Future jobs a driver still holds — what makes deactivating them risky. */
export async function findFutureJobs(driverId: string) {
  return prisma.job.findMany({
    where: {
      driverId,
      scheduledAt: { gte: new Date() },
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 20,
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      status: true,
    },
  });
}

export async function createDriver(
  input: DriverInput,
  context: AuditContext,
): Promise<{ id: string; reference: string }> {
  return withDriverReference(async (reference) =>
    withAudit(
      'Driver',
      'create',
      async (tx) => {
        const created = await tx.driver.create({
          data: { ...toData(input), reference },
        });
        return {
          entityId: created.id,
          after: created,
          result: { id: created.id, reference: created.reference },
        };
      },
      context,
    ),
  );
}

export async function updateDriver(
  id: string,
  input: DriverInput,
  context: AuditContext,
): Promise<{ id: string }> {
  return withAudit(
    'Driver',
    'update',
    async (tx) => {
      const before = await tx.driver.findUniqueOrThrow({ where: { id } });
      // `reference` is deliberately not in `toData` — it is immutable once
      // allocated, because it ends up on paperwork.
      const after = await tx.driver.update({ where: { id }, data: toData(input) });
      return { entityId: id, before, after, result: { id } };
    },
    context,
  );
}

export async function archiveDriver(
  id: string,
  context: AuditContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const futureJobs = await findFutureJobs(id);

  if (futureJobs.length > 0) {
    return {
      ok: false,
      reason: `This driver is on ${futureJobs.length} upcoming job${
        futureJobs.length === 1 ? '' : 's'
      }. Reassign or cancel them first.`,
    };
  }

  await withAudit(
    'Driver',
    'delete',
    async (tx) => {
      const before = await tx.driver.findUniqueOrThrow({ where: { id } });
      await tx.driver.update({ where: { id }, data: { deletedAt: new Date() } });
      return { entityId: id, before, result: null };
    },
    context,
  );

  return { ok: true };
}
