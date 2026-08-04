import type { DocumentType } from '@prisma/client';
import { daysBetweenDates, endOfExpiryDay } from './dates';

/**
 * Whether a driver or vehicle may legally be put on a job.
 *
 * This is a licensing requirement, not a preference. The legacy system stored
 * PHV badges, MOT certificates and insurance as images with no dates, so
 * nothing could tell you anything was about to lapse — compliance was a
 * memory-based process. Everything here exists to replace that memory.
 *
 * Two rules are easy to get wrong and both are load-bearing:
 *
 *   Expiry is inclusive. A badge expiring 14 July is valid through the end of
 *   14 July, local time. Off by a day in one direction bans a compliant
 *   driver; off by a day in the other lets a lapsed one work.
 *
 *   An unknown expiry is not compliance. A document with no recorded date
 *   cannot be assumed valid — the whole reason this system exists is that the
 *   old one made exactly that assumption.
 */

export type ComplianceLevel =
  | 'ok'
  | 'warning'
  | 'critical'
  | 'expired'
  | 'unknown';

/** Default thresholds, overridable in Settings. */
export const DEFAULT_WARNING_DAYS = 30;
export const DEFAULT_CRITICAL_DAYS = 7;

export interface ComplianceThresholds {
  warningDays: number;
  criticalDays: number;
}

export const DEFAULT_THRESHOLDS: ComplianceThresholds = {
  warningDays: DEFAULT_WARNING_DAYS,
  criticalDays: DEFAULT_CRITICAL_DAYS,
};

/** One dated requirement — a licence, an MOT, an insurance policy. */
export interface ComplianceItem {
  /** What this is, for the operator to read. */
  label: string;
  /** The document type it corresponds to, where there is one. */
  documentType: DocumentType | null;
  expiresOn: Date | null;
  level: ComplianceLevel;
  /** Negative once lapsed. Null when no date is recorded. */
  daysRemaining: number | null;
}

export interface ComplianceResult {
  compliant: boolean;
  /** Human-readable, and specific enough to act on. */
  reasons: string[];
  /** The worst state across every requirement — what the indicator shows. */
  level: ComplianceLevel;
  items: ComplianceItem[];
}

/** Worst-first, so the indicator can take the head of the list. */
const SEVERITY: ComplianceLevel[] = [
  'expired',
  'unknown',
  'critical',
  'warning',
  'ok',
];

export function worstLevel(levels: ComplianceLevel[]): ComplianceLevel {
  for (const level of SEVERITY) {
    if (levels.includes(level)) return level;
  }
  return 'ok';
}

/**
 * Classify one expiry date as at a moment in time.
 *
 * `at` is usually now, but for assignment it is the job's `scheduledAt`: a
 * badge valid today and lapsed by next Tuesday must not be assignable to next
 * Tuesday's airport run.
 */
export function classifyExpiry(
  expiresOn: Date | null | undefined,
  at: Date,
  thresholds: ComplianceThresholds = DEFAULT_THRESHOLDS,
  timeZone?: string,
): { level: ComplianceLevel; daysRemaining: number | null } {
  if (!expiresOn) return { level: 'unknown', daysRemaining: null };

  const validUntil = endOfExpiryDay(expiresOn, timeZone);
  const daysRemaining = daysBetweenDates(at, expiresOn, timeZone);

  // Inclusive: still valid at any instant before the end of the expiry day.
  if (at.getTime() >= validUntil.getTime()) {
    return { level: 'expired', daysRemaining };
  }
  if (daysRemaining <= thresholds.criticalDays) {
    return { level: 'critical', daysRemaining };
  }
  if (daysRemaining <= thresholds.warningDays) {
    return { level: 'warning', daysRemaining };
  }
  return { level: 'ok', daysRemaining };
}

/** The dated fields a driver must hold. */
export interface DriverComplianceInput {
  name?: string;
  dvlaLicenceExpiry: Date | null;
  phvBadgeExpiry: Date | null;
}

/** The dated fields a vehicle must hold. */
export interface VehicleComplianceInput {
  registration?: string;
  motExpiry: Date | null;
  insuranceExpiry: Date | null;
  phvLicenceExpiry: Date | null;
}

const DRIVER_REQUIREMENTS: Array<{
  key: keyof DriverComplianceInput;
  label: string;
  documentType: DocumentType;
}> = [
  { key: 'dvlaLicenceExpiry', label: 'DVLA licence', documentType: 'DVLA_LICENCE' },
  { key: 'phvBadgeExpiry', label: 'PHV badge', documentType: 'PHV_BADGE' },
];

const VEHICLE_REQUIREMENTS: Array<{
  key: keyof VehicleComplianceInput;
  label: string;
  documentType: DocumentType;
}> = [
  { key: 'motExpiry', label: 'MOT', documentType: 'MOT' },
  { key: 'insuranceExpiry', label: 'Insurance', documentType: 'INSURANCE' },
  {
    key: 'phvLicenceExpiry',
    label: 'PHV vehicle licence',
    documentType: 'PHV_VEHICLE',
  },
];

function evaluate(
  requirements: Array<{ label: string; documentType: DocumentType }>,
  values: Array<Date | null>,
  at: Date,
  thresholds: ComplianceThresholds,
  timeZone?: string,
): ComplianceResult {
  const items: ComplianceItem[] = requirements.map((requirement, index) => {
    const expiresOn = values[index] ?? null;
    const { level, daysRemaining } = classifyExpiry(
      expiresOn,
      at,
      thresholds,
      timeZone,
    );
    return {
      label: requirement.label,
      documentType: requirement.documentType,
      expiresOn,
      level,
      daysRemaining,
    };
  });

  const reasons = items
    .filter((item) => item.level === 'expired' || item.level === 'unknown')
    .map((item) =>
      item.level === 'unknown'
        ? `${item.label} has no expiry date recorded`
        : `${item.label} expired ${formatDaysAgo(item.daysRemaining)}`,
    );

  return {
    compliant: reasons.length === 0,
    reasons,
    level: worstLevel(items.map((item) => item.level)),
    items,
  };
}

function formatDaysAgo(daysRemaining: number | null): string {
  if (daysRemaining === null) return 'at an unknown date';
  const days = Math.abs(daysRemaining);
  if (days === 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function driverComplianceAt(
  driver: DriverComplianceInput,
  at: Date,
  thresholds: ComplianceThresholds = DEFAULT_THRESHOLDS,
  timeZone?: string,
): ComplianceResult {
  return evaluate(
    DRIVER_REQUIREMENTS,
    [driver.dvlaLicenceExpiry, driver.phvBadgeExpiry],
    at,
    thresholds,
    timeZone,
  );
}

export function vehicleComplianceAt(
  vehicle: VehicleComplianceInput,
  at: Date,
  thresholds: ComplianceThresholds = DEFAULT_THRESHOLDS,
  timeZone?: string,
): ComplianceResult {
  return evaluate(
    VEHICLE_REQUIREMENTS,
    [vehicle.motExpiry, vehicle.insuranceExpiry, vehicle.phvLicenceExpiry],
    at,
    thresholds,
    timeZone,
  );
}

/**
 * A driver's own compliance combined with that of the vehicle they will
 * drive.
 *
 * A compliant driver in an uninsured car is not a job that can go out, so the
 * indicator on the driver list spans both. Note the vehicle is passed in
 * rather than assumed: a job may override the driver's assigned vehicle, and
 * `job.vehicleId === driver.assignedVehicleId` must never be taken on trust.
 */
export function combinedComplianceAt(
  driver: DriverComplianceInput,
  vehicle: VehicleComplianceInput | null,
  at: Date,
  thresholds: ComplianceThresholds = DEFAULT_THRESHOLDS,
  timeZone?: string,
): ComplianceResult {
  const driverResult = driverComplianceAt(driver, at, thresholds, timeZone);
  if (!vehicle) return driverResult;

  const vehicleResult = vehicleComplianceAt(vehicle, at, thresholds, timeZone);
  const prefix = vehicle.registration ? `${vehicle.registration}: ` : 'Vehicle: ';

  return {
    compliant: driverResult.compliant && vehicleResult.compliant,
    reasons: [
      ...driverResult.reasons,
      ...vehicleResult.reasons.map((reason) => `${prefix}${reason}`),
    ],
    level: worstLevel([driverResult.level, vehicleResult.level]),
    items: [...driverResult.items, ...vehicleResult.items],
  };
}

// ------------------------------------------------------- database lookups
//
// The evaluators above are pure so they can be tested exhaustively. These
// wrappers fetch the record and apply them, and are what job assignment in
// Phase 2 calls.

/**
 * Is this driver — and the vehicle they will actually drive — compliant at
 * `at`?
 *
 * Pass `vehicleId` explicitly when the job overrides the driver's assigned
 * vehicle. Omitting it falls back to the assigned one, which is the common
 * case but must never be assumed.
 */
export async function isDriverCompliantAt(
  driverId: string,
  at: Date,
  options: { vehicleId?: string | null; includeVehicle?: boolean } = {},
): Promise<ComplianceResult> {
  const { prisma } = await import('./prisma');
  const { getComplianceThresholds } = await import('./settings');
  const thresholds = await getComplianceThresholds();

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: {
      name: true,
      dvlaLicenceExpiry: true,
      phvBadgeExpiry: true,
      assignedVehicleId: true,
    },
  });

  if (!driver) {
    return {
      compliant: false,
      reasons: ['That driver no longer exists'],
      level: 'expired',
      items: [],
    };
  }

  const includeVehicle = options.includeVehicle ?? true;
  const vehicleId =
    options.vehicleId === undefined ? driver.assignedVehicleId : options.vehicleId;

  if (!includeVehicle || !vehicleId) {
    return driverComplianceAt(driver, at, thresholds);
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: {
      registration: true,
      motExpiry: true,
      insuranceExpiry: true,
      phvLicenceExpiry: true,
    },
  });

  return combinedComplianceAt(driver, vehicle, at, thresholds);
}

/** Is this vehicle compliant at `at`? */
export async function isVehicleCompliantAt(
  vehicleId: string,
  at: Date,
): Promise<ComplianceResult> {
  const { prisma } = await import('./prisma');
  const { getComplianceThresholds } = await import('./settings');
  const thresholds = await getComplianceThresholds();

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: {
      registration: true,
      motExpiry: true,
      insuranceExpiry: true,
      phvLicenceExpiry: true,
    },
  });

  if (!vehicle) {
    return {
      compliant: false,
      reasons: ['That vehicle no longer exists'],
      level: 'expired',
      items: [],
    };
  }

  return vehicleComplianceAt(vehicle, at, thresholds);
}

/** Indicator colour, as a semantic token rather than a literal. */
export const LEVEL_BADGE: Record<
  ComplianceLevel,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }
> = {
  ok: { label: 'Compliant', variant: 'success' },
  warning: { label: 'Expiring soon', variant: 'warning' },
  critical: { label: 'Expiring', variant: 'destructive' },
  expired: { label: 'Expired', variant: 'destructive' },
  unknown: { label: 'No expiry recorded', variant: 'secondary' },
};
