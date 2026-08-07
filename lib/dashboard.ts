import { buildComplianceReport } from './compliance-report';
import { endOfZonedDay, startOfZonedDay } from './dates';
import { creditedTotalPence, outstandingPence, SETTLED } from './invoices';
import { countUnpricedCompleted } from './jobs';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import { reportBreakdown, reportSummary, reportTrend } from './reports';
import { getComplianceThresholds, getSettings } from './settings';

/**
 * The numbers somebody wants on opening the app — spec 6.6.
 *
 * Every figure here already exists somewhere: the compliance report, the
 * unpriced count, the reports module. This assembles them, and its whole job
 * is to do that in parallel rather than in sequence — eight sequential
 * queries is a dashboard people stop opening.
 *
 * What it deliberately does not do is compute anything new. A tile that
 * disagreed with the report it links to would be worse than no tile.
 */

export interface DashboardTile {
  key: string;
  href: string;
  label: string;
  value: string;
  hint?: string;
  tone: 'ok' | 'warning' | 'destructive' | 'neutral';
  /** Money tiles are hidden from roles that may not see revenue. */
  money?: boolean;
}

export interface DashboardData {
  tiles: DashboardTile[];
  trend: Awaited<ReturnType<typeof reportTrend>>;
  topClients: Awaited<ReturnType<typeof reportBreakdown>>;
  topDrivers: Awaited<ReturnType<typeof reportBreakdown>>;
  monthLabel: string;
}

export async function loadDashboard(options: {
  seesMoney: boolean;
  now?: Date;
}): Promise<DashboardData> {
  const now = options.now ?? new Date();
  const [{ timeZone, locale, currency }, thresholds, settings] = await Promise.all([
    getLocaleConfig(),
    getComplianceThresholds(),
    getSettings(),
  ]);

  const todayFrom = startOfZonedDay(now, timeZone);
  const todayTo = endOfZonedDay(now, timeZone);
  const weekTo = endOfZonedDay(
    new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000),
    timeZone,
  );
  const next24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const monthFrom = startOfMonth(now, timeZone);

  const blank = { clientId: null, accountId: null, driverId: null, vehicleId: null, jobType: null };
  const thisMonthFilters = { from: monthFrom, to: now, ...blank };
  // Spec 6.6.4 — twelve months, which is what makes a seasonal dip readable
  // as a season rather than as a problem.
  const yearFilters = {
    from: startOfMonth(new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), timeZone),
    to: now,
    ...blank,
  };

  const [
    jobsToday,
    jobsThisWeek,
    unassignedSoon,
    unpricedCompleted,
    compliance,
    overdue,
    thisMonth,
    trend,
    topClients,
    topDrivers,
  ] = await Promise.all([
    prisma.job.count({
      where: {
        scheduledAt: { gte: todayFrom, lte: todayTo },
        status: { notIn: ['CANCELLED'] },
      },
    }),
    prisma.job.count({
      where: {
        scheduledAt: { gte: todayFrom, lte: weekTo },
        status: { notIn: ['CANCELLED'] },
      },
    }),
    prisma.job.count({
      where: {
        driverId: null,
        scheduledAt: { gte: now, lte: next24 },
        status: { in: ['PENDING', 'DRAFT'] },
      },
    }),
    countUnpricedCompleted(),
    buildComplianceReport(thresholds),
    prisma.invoice.findMany({
      where: {
        status: { notIn: SETTLED },
        dueDate: { lt: now },
      },
      // Credits included, or the tile chases money already given back.
      select: {
        grossPence: true,
        paidPence: true,
        creditNotes: { select: { grossPence: true } },
      },
      take: 500,
    }),
    // Month to date, on the same expressions the reports use — so the tile
    // and the report it links to cannot disagree.
    reportSummary(thisMonthFilters),
    reportTrend(yearFilters),
    reportBreakdown(thisMonthFilters, 'client'),
    reportBreakdown(thisMonthFilters, 'driver'),
  ]);

  const overdueTotal = overdue.reduce(
    (sum, invoice) =>
      sum +
      outstandingPence({
        ...invoice,
        creditedPence: creditedTotalPence(invoice.creditNotes),
      }),
    0,
  );

  // Currency from settings, never a hardcoded symbol — a tile is as much
  // "the edge" as an invoice is. Whole pounds: a dashboard is for noticing,
  // and pence on a headline figure is noise.
  const money = (pence: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(pence / 100);

  const tiles: DashboardTile[] = [
    {
      key: 'today',
      href: `/jobs?from=${isoDay(todayFrom)}&to=${isoDay(todayTo)}`,
      label: 'Jobs today',
      value: String(jobsToday),
      tone: 'neutral',
    },
    {
      key: 'week',
      href: `/jobs?from=${isoDay(todayFrom)}&to=${isoDay(weekTo)}`,
      label: 'Jobs this week',
      value: String(jobsThisWeek),
      tone: 'neutral',
    },
    {
      key: 'unassigned',
      href: '/dispatch',
      label: 'Unassigned in 24h',
      value: String(unassignedSoon),
      hint: unassignedSoon > 0 ? 'Somebody has to pick these up' : undefined,
      tone: unassignedSoon > 0 ? 'warning' : 'ok',
    },
    {
      key: 'unpriced',
      href: '/jobs?unpriced=true',
      label: 'Completed, unpriced',
      value: String(unpricedCompleted),
      hint: 'The number this rebuild exists to keep at zero',
      tone:
        unpricedCompleted === 0
          ? 'ok'
          : unpricedCompleted >= settings.unpricedAlertThreshold
            ? 'destructive'
            : 'warning',
    },
    {
      key: 'expiring',
      href: '/compliance',
      label: 'Documents expiring',
      value: String(compliance.counts.critical + compliance.counts.warning),
      hint:
        compliance.counts.expired > 0
          ? `${compliance.counts.expired} already expired`
          : undefined,
      tone:
        compliance.counts.expired > 0
          ? 'destructive'
          : compliance.counts.critical > 0
            ? 'warning'
            : 'ok',
    },
    {
      key: 'overdue',
      href: '/invoices?overdue=true',
      label: 'Overdue invoices',
      value: String(overdue.length),
      hint: overdue.length > 0 ? money(overdueTotal) : undefined,
      tone: overdue.length > 0 ? 'warning' : 'ok',
      money: true,
    },
    {
      key: 'revenue',
      href: '/reports',
      label: 'Revenue this month',
      value: money(thisMonth.revenuePence),
      hint: `${thisMonth.jobs} jobs`,
      tone: 'neutral',
      money: true,
    },
    {
      key: 'profit',
      href: '/reports',
      label: 'Gross profit this month',
      value: money(thisMonth.profitPence),
      hint:
        thisMonth.marginPct === null
          ? undefined
          : `${thisMonth.marginPct.toFixed(1)}% margin`,
      tone: thisMonth.profitPence < 0 ? 'destructive' : 'neutral',
      money: true,
    },
  ];

  return {
    // Spec 6.6.6 — OPS does not see revenue tiles. Filtered here rather than
    // in the page, so a second caller cannot forget.
    tiles: options.seesMoney ? tiles : tiles.filter((tile) => !tile.money),
    trend,
    topClients: topClients.slice(0, 5),
    topDrivers: topDrivers.slice(0, 5),
    monthLabel: new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone,
    }).format(now),
  };
}

function startOfMonth(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  return startOfZonedDay(new Date(`${year}-${month}-01T12:00:00Z`), timeZone);
}

function isoDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
