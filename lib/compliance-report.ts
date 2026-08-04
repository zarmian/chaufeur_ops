import {
  classifyExpiry,
  type ComplianceLevel,
  type ComplianceThresholds,
} from './compliance';
import { daysBetweenDates } from './dates';
import { prisma } from './prisma';

/**
 * The fleet-wide expiry picture.
 *
 * The feature the legacy system lacked entirely, and the reason Phase 1 sits
 * before jobs: an operator licence depends on knowing this, and knowing it
 * from memory does not scale past a handful of drivers.
 */

export interface ExpiringRow {
  kind: 'DRIVER' | 'VEHICLE';
  id: string;
  name: string;
  reference: string | null;
  documentType: string;
  documentLabel: string;
  expiresOn: Date | null;
  daysRemaining: number | null;
  level: ComplianceLevel;
  href: string;
}

export interface ComplianceReport {
  expired: ExpiringRow[];
  critical: ExpiringRow[];
  warning: ExpiringRow[];
  /** Kept apart, per the spec: unknown is not a severity, it is a gap. */
  unknownExpiry: ExpiringRow[];
  counts: {
    expired: number;
    critical: number;
    warning: number;
    unknownExpiry: number;
  };
}

const DRIVER_FIELDS = [
  { key: 'dvlaLicenceExpiry', type: 'DVLA_LICENCE', label: 'DVLA licence' },
  { key: 'phvBadgeExpiry', type: 'PHV_BADGE', label: 'PHV badge' },
] as const;

const VEHICLE_FIELDS = [
  { key: 'motExpiry', type: 'MOT', label: 'MOT' },
  { key: 'insuranceExpiry', type: 'INSURANCE', label: 'Insurance' },
  {
    key: 'phvLicenceExpiry',
    type: 'PHV_VEHICLE',
    label: 'PHV vehicle licence',
  },
] as const;

/**
 * Every lapsing or undated requirement across drivers and vehicles.
 *
 * Retired vehicles and archived drivers are excluded — chasing an MOT on a
 * car that left the fleet is noise, and noise is what gets a compliance
 * dashboard ignored.
 */
export async function buildComplianceReport(
  thresholds: ComplianceThresholds,
  now = new Date(),
): Promise<ComplianceReport> {
  const [drivers, vehicles] = await Promise.all([
    prisma.driver.findMany({
      where: { status: { not: 'INACTIVE' } },
      select: {
        id: true,
        name: true,
        reference: true,
        dvlaLicenceExpiry: true,
        phvBadgeExpiry: true,
      },
    }),
    prisma.vehicle.findMany({
      where: { status: { not: 'RETIRED' } },
      select: {
        id: true,
        registration: true,
        motExpiry: true,
        insuranceExpiry: true,
        phvLicenceExpiry: true,
      },
    }),
  ]);

  const rows: ExpiringRow[] = [];

  for (const driver of drivers) {
    for (const field of DRIVER_FIELDS) {
      const expiresOn = driver[field.key];
      const { level, daysRemaining } = classifyExpiry(
        expiresOn,
        now,
        thresholds,
      );
      if (level === 'ok') continue;
      rows.push({
        kind: 'DRIVER',
        id: driver.id,
        name: driver.name,
        reference: driver.reference,
        documentType: field.type,
        documentLabel: field.label,
        expiresOn,
        daysRemaining,
        level,
        href: `/drivers/${driver.id}`,
      });
    }
  }

  for (const vehicle of vehicles) {
    for (const field of VEHICLE_FIELDS) {
      const expiresOn = vehicle[field.key];
      const { level, daysRemaining } = classifyExpiry(
        expiresOn,
        now,
        thresholds,
      );
      if (level === 'ok') continue;
      rows.push({
        kind: 'VEHICLE',
        id: vehicle.id,
        name: vehicle.registration,
        reference: null,
        documentType: field.type,
        documentLabel: field.label,
        expiresOn,
        daysRemaining,
        level,
        href: `/vehicles/${vehicle.id}`,
      });
    }
  }

  // Most urgent first: the longest-lapsed at the top, because that is the one
  // that has been putting the licence at risk for longest.
  const byUrgency = (a: ExpiringRow, b: ExpiringRow) =>
    (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0);

  const expired = rows.filter((r) => r.level === 'expired').sort(byUrgency);
  const critical = rows.filter((r) => r.level === 'critical').sort(byUrgency);
  const warning = rows.filter((r) => r.level === 'warning').sort(byUrgency);
  const unknownExpiry = rows
    .filter((r) => r.level === 'unknown')
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    expired,
    critical,
    warning,
    unknownExpiry,
    counts: {
      expired: expired.length,
      critical: critical.length,
      warning: warning.length,
      unknownExpiry: unknownExpiry.length,
    },
  };
}

/** The shape `GET /api/compliance/expiring` returns, per `docs/api-spec.md`. */
export function toApiShape(report: ComplianceReport, now = new Date()) {
  const map = (row: ExpiringRow) => ({
    kind: row.kind,
    id: row.id,
    name: row.name,
    documentType: row.documentType,
    expiresOn: row.expiresOn
      ? row.expiresOn.toISOString().slice(0, 10)
      : null,
    daysRemaining:
      row.expiresOn === null ? null : daysBetweenDates(now, row.expiresOn),
  });

  return {
    expired: report.expired.map(map),
    critical: report.critical.map(map),
    warning: report.warning.map(map),
    unknownExpiry: report.unknownExpiry.map(map),
    counts: report.counts,
  };
}

/** Rows for the spreadsheet export, flattened and already human-readable. */
export function toExportRows(report: ComplianceReport) {
  return [
    ...report.expired,
    ...report.critical,
    ...report.warning,
    ...report.unknownExpiry,
  ].map((row) => ({
    Type: row.kind === 'DRIVER' ? 'Driver' : 'Vehicle',
    Name: row.name,
    Reference: row.reference ?? '',
    Document: row.documentLabel,
    Expires: row.expiresOn
      ? row.expiresOn.toISOString().slice(0, 10)
      : 'Not recorded',
    'Days remaining': row.daysRemaining ?? '',
    Status:
      row.level === 'unknown'
        ? 'Expiry not recorded'
        : row.level.charAt(0).toUpperCase() + row.level.slice(1),
  }));
}
