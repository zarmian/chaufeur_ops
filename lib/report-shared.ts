import type { SearchParams } from './list-params';
import { prisma } from './prisma';
import { describeFilters, type Dimension, type ReportFilters } from './reports';

/**
 * Turning a report URL back into filters, for the exports.
 *
 * Shared so a spreadsheet and a PDF cannot silently cover different jobs
 * from the screen that produced them — the whole point of printing the
 * criteria on the export is that the numbers can be trusted, and two
 * parsers would eventually disagree.
 */
export function filtersFromParams(params: URLSearchParams): ReportFilters {
  return {
    from: date(params, 'from') ?? yearAgo(),
    to: date(params, 'to', true) ?? endOfToday(),
    driverId: value(params, 'driverId'),
    clientId: value(params, 'clientId'),
    accountId: value(params, 'accountId'),
    vehicleId: value(params, 'vehicleId'),
    jobType: value(params, 'jobType'),
    status: value(params, 'status'),
  };
}

const DIMENSIONS: Dimension[] = [
  'jobType',
  'client',
  'account',
  'driver',
  'vehicle',
];

export function dimensionFromParams(params: URLSearchParams): Dimension {
  const requested = params.get('by');
  return DIMENSIONS.find((option) => option === requested) ?? 'client';
}

/**
 * The filters in words, with the ids resolved to names.
 *
 * A header reading `driver cmsg…` is no more informative than no header.
 */
export async function describeFiltersWithNames(
  filters: ReportFilters,
): Promise<string> {
  const [driver, client, account, vehicle] = await Promise.all([
    filters.driverId
      ? prisma.driver.findUnique({
          where: { id: filters.driverId },
          select: { name: true },
        })
      : null,
    filters.clientId
      ? prisma.client.findUnique({
          where: { id: filters.clientId },
          select: { name: true },
        })
      : null,
    filters.accountId
      ? prisma.account.findUnique({
          where: { id: filters.accountId },
          select: { name: true },
        })
      : null,
    filters.vehicleId
      ? prisma.vehicle.findUnique({
          where: { id: filters.vehicleId },
          select: { registration: true },
        })
      : null,
  ]);

  return describeFilters(filters, {
    ...(driver ? { driver: driver.name } : {}),
    ...(client ? { client: client.name } : {}),
    ...(account ? { account: account.name } : {}),
    ...(vehicle ? { vehicle: vehicle.registration } : {}),
  });
}

function value(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (!raw || raw === 'all') return null;
  return raw;
}

function date(
  params: URLSearchParams,
  key: string,
  endOfDay = false,
): Date | null {
  const raw = params.get(key);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
}

function yearAgo(): Date {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function endOfToday(): Date {
  const date = new Date();
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

/** Kept out of `SearchParams` so route handlers can share one parser. */
export function toURLSearchParams(params: SearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    const single = Array.isArray(raw) ? raw[0] : raw;
    if (single) out.set(key, single);
  }
  return out;
}
