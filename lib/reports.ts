import { Prisma } from '@prisma/client';
import { marginPct } from './money';
import { prisma } from './prisma';

/**
 * Reporting aggregates.
 *
 * Computed in SQL rather than by pulling rows into memory — spec 4.6.8. A
 * year is tens of thousands of jobs, and the alternative is a report that
 * gets slower every month until nobody opens it, which is exactly what the
 * legacy system did.
 *
 * The arithmetic here has to match `jobEconomics` in `lib/job-finance.ts`
 * exactly, because the same job appears on the finance panel, the invoice and
 * this report and all three have to agree. Spec 4.6.9 makes that a test
 * rather than an intention: `reports.integration.test.ts` sums the underlying
 * records in TypeScript and asserts the SQL total equals it to the penny.
 *
 * The rules being reproduced, in the same order:
 *
 * - **A finance record wins over the booking price.** With one, the client
 *   side is its base fare plus waiting plus extras plus hourly work. Without
 *   one, the booking price stands in, so a job priced on the phone and never
 *   opened in the panel still reports honestly.
 * - **Stops and recharged expenses are revenue.** They are charged to the
 *   client, so leaving them out would understate what the job earned.
 * - **Only company-borne expenses are costs.** An expense the driver bears is
 *   neither revenue nor cost; one recharged to the client is revenue.
 * - **A shift-paid job carries no driver cost.** The pay is on the shift, and
 *   counting it here as well would double the cost of every run inside it.
 */

export interface ReportFilters {
  from: Date;
  to: Date;
  driverId?: string | null;
  clientId?: string | null;
  accountId?: string | null;
  vehicleId?: string | null;
  jobType?: string | null;
  status?: string | null;
}

export type Dimension =
  | 'jobType'
  | 'client'
  | 'account'
  | 'driver'
  | 'vehicle';

/**
 * The per-job revenue expression.
 *
 * `COALESCE(f."baseFarePence", j."clientPricePence", 0)` is the whole
 * finance-record-wins rule in one line: when a finance row exists its base
 * fare is authoritative even if it is zero, and only its absence falls back
 * to what was agreed at booking.
 */
const CLIENT_PENCE = Prisma.sql`(
  CASE WHEN f."jobId" IS NULL
    THEN COALESCE(j."clientPricePence", 0)
    ELSE COALESCE(f."baseFarePence", 0)
       + COALESCE(f."waitTimePence", 0)
       + COALESCE(f."extraChargesPence", 0)
       + ROUND(COALESCE(f."customerHours", 0) * COALESCE(f."customerRatePence", 0))
  END
  + COALESCE(s.stop_pence, 0)
  + COALESCE(e.client_pence, 0)
)`;

const COST_PENCE = Prisma.sql`(
  CASE WHEN j."shiftId" IS NOT NULL
    -- Paid by the hour on the shift. Counting a fee here as well would pay
    -- twice on the report exactly as it would in a payout.
    THEN 0
    ELSE CASE WHEN f."jobId" IS NULL
      THEN COALESCE(j."driverPricePence", 0)
      ELSE COALESCE(f."driverPaymentPence", 0)
         + ROUND(COALESCE(f."driverHours", 0) * COALESCE(f."driverRatePence", 0))
    END
  END
  + CASE WHEN f."jobId" IS NULL THEN 0
    ELSE COALESCE(f."fuelCostPence", 0) + COALESCE(f."otherExpensesPence", 0)
  END
  + COALESCE(e.company_pence, 0)
)`;

/**
 * Jobs joined to everything their economics depend on.
 *
 * Stops and expenses are pre-aggregated in subqueries rather than joined
 * directly: a job with three stops and two expenses would otherwise appear
 * six times and multiply its own fare.
 */
const JOB_FROM = Prisma.sql`
  FROM "Job" j
  LEFT JOIN "JobFinance" f ON f."jobId" = j.id
  LEFT JOIN (
    SELECT "jobId", SUM("chargePence") AS stop_pence
    FROM "JobStop" GROUP BY "jobId"
  ) s ON s."jobId" = j.id
  LEFT JOIN (
    SELECT "jobId",
           SUM(CASE WHEN "borneBy" = 'CLIENT' THEN "amountPence" ELSE 0 END) AS client_pence,
           SUM(CASE WHEN "borneBy" = 'COMPANY' THEN "amountPence" ELSE 0 END) AS company_pence
    FROM "JobExpense" WHERE "deletedAt" IS NULL GROUP BY "jobId"
  ) e ON e."jobId" = j.id
`;

/**
 * The filter clause, kept apart from the joins.
 *
 * Separate so a caller can add its own `LEFT JOIN` between the two: SQL puts
 * every join before the `WHERE`, and a single source fragment that ended in
 * the filter would make the grouped and detailed queries unbuildable.
 */
function jobWhere(filters: ReportFilters): Prisma.Sql {
  return Prisma.sql`
    WHERE j."deletedAt" IS NULL
      AND j."scheduledAt" >= ${filters.from}
      AND j."scheduledAt" <= ${filters.to}
      ${filters.driverId ? Prisma.sql`AND j."driverId" = ${filters.driverId}` : Prisma.empty}
      ${filters.clientId ? Prisma.sql`AND j."clientId" = ${filters.clientId}` : Prisma.empty}
      ${filters.accountId ? Prisma.sql`AND j."accountId" = ${filters.accountId}` : Prisma.empty}
      ${filters.vehicleId ? Prisma.sql`AND j."vehicleId" = ${filters.vehicleId}` : Prisma.empty}
      ${filters.jobType ? Prisma.sql`AND j."jobType"::text = ${filters.jobType}` : Prisma.empty}
      ${
        filters.status
          ? Prisma.sql`AND j."status"::text = ${filters.status}`
          : // Cancelled work is not revenue and never was. Left out by
            // default rather than filtered by the operator, because a report
            // that counted it would overstate every figure on the page.
            Prisma.sql`AND j."status"::text <> 'CANCELLED'`
      }
  `;
}

/** Source and filter together, for a query that needs no extra joins. */
function jobSource(filters: ReportFilters): Prisma.Sql {
  return Prisma.sql`${JOB_FROM} ${jobWhere(filters)}`;
}

export interface ReportSummary {
  jobs: number;
  revenuePence: number;
  costsPence: number;
  profitPence: number;
  /** Null on no revenue: a margin on nothing is undefined, not zero. */
  marginPct: number | null;
  /** Spec 4.6.2 and 4.6.3 — shown as prominently as revenue. */
  unpricedJobs: number;
}

export async function reportSummary(
  filters: ReportFilters,
): Promise<ReportSummary> {
  const rows = await prisma.$queryRaw<
    Array<{
      jobs: bigint;
      revenue: bigint | null;
      costs: bigint | null;
      unpriced: bigint;
    }>
  >(Prisma.sql`
    SELECT COUNT(*)::bigint AS jobs,
           SUM(${CLIENT_PENCE})::bigint AS revenue,
           SUM(${COST_PENCE})::bigint AS costs,
           -- A job with no client price is a data-quality defect, not a free
           -- job. Counted so the revenue figure above can be read honestly.
           COUNT(*) FILTER (WHERE ${CLIENT_PENCE} <= 0)::bigint AS unpriced
    ${jobSource(filters)}
  `);

  const row = rows[0];
  const revenuePence = Number(row?.revenue ?? 0);
  const costsPence = Number(row?.costs ?? 0);
  const profitPence = revenuePence - costsPence;

  return {
    jobs: Number(row?.jobs ?? 0),
    revenuePence,
    costsPence,
    profitPence,
    marginPct: marginPct(revenuePence, profitPence),
    unpricedJobs: Number(row?.unpriced ?? 0),
  };
}

export interface BreakdownRow {
  id: string | null;
  label: string;
  jobs: number;
  revenuePence: number;
  costsPence: number;
  profitPence: number;
  marginPct: number | null;
}

/** How each dimension names and groups itself. */
const DIMENSIONS: Record<
  Dimension,
  { join: Prisma.Sql; id: Prisma.Sql; label: Prisma.Sql }
> = {
  jobType: {
    join: Prisma.empty,
    id: Prisma.sql`j."jobType"::text`,
    label: Prisma.sql`j."jobType"::text`,
  },
  client: {
    join: Prisma.sql`LEFT JOIN "Client" c ON c.id = j."clientId"`,
    id: Prisma.sql`j."clientId"`,
    label: Prisma.sql`COALESCE(c."name", 'No client recorded')`,
  },
  account: {
    join: Prisma.sql`LEFT JOIN "Account" a ON a.id = j."accountId"`,
    id: Prisma.sql`j."accountId"`,
    label: Prisma.sql`COALESCE(a."name", 'No account')`,
  },
  driver: {
    join: Prisma.sql`LEFT JOIN "Driver" d ON d.id = j."driverId"`,
    id: Prisma.sql`j."driverId"`,
    label: Prisma.sql`COALESCE(d."name", 'Unassigned')`,
  },
  vehicle: {
    join: Prisma.sql`LEFT JOIN "Vehicle" v ON v.id = j."vehicleId"`,
    id: Prisma.sql`j."vehicleId"`,
    label: Prisma.sql`COALESCE(v."registration", 'No vehicle')`,
  },
};

/**
 * Revenue, cost, profit and margin by one dimension — spec 4.6.4.
 *
 * Worst margin last rather than smallest revenue last: a client billing a
 * lot at no margin is the finding worth acting on, and sorting by revenue
 * would bury it at the top looking like success.
 */
export async function reportBreakdown(
  filters: ReportFilters,
  dimension: Dimension,
  limit = 50,
): Promise<BreakdownRow[]> {
  const dim = DIMENSIONS[dimension];

  const rows = await prisma.$queryRaw<
    Array<{
      id: string | null;
      label: string;
      jobs: bigint;
      revenue: bigint | null;
      costs: bigint | null;
    }>
  >(Prisma.sql`
    SELECT ${dim.id} AS id,
           ${dim.label} AS label,
           COUNT(*)::bigint AS jobs,
           SUM(${CLIENT_PENCE})::bigint AS revenue,
           SUM(${COST_PENCE})::bigint AS costs
    ${JOB_FROM}
    ${dim.join}
    ${jobWhere(filters)}
    GROUP BY 1, 2
    ORDER BY revenue DESC NULLS LAST
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const revenuePence = Number(row.revenue ?? 0);
    const costsPence = Number(row.costs ?? 0);
    const profitPence = revenuePence - costsPence;
    return {
      id: row.id,
      label: row.label,
      jobs: Number(row.jobs),
      revenuePence,
      costsPence,
      profitPence,
      marginPct: marginPct(revenuePence, profitPence),
    };
  });
}

export interface TrendPoint {
  month: string;
  jobs: number;
  revenuePence: number;
  profitPence: number;
}

/**
 * Revenue and profit by month — spec 4.6.5.
 *
 * Bucketed in the database rather than in JavaScript, so a two-year range is
 * twenty-four rows over the wire instead of every job in it.
 */
export async function reportTrend(
  filters: ReportFilters,
): Promise<TrendPoint[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      month: Date;
      jobs: bigint;
      revenue: bigint | null;
      costs: bigint | null;
    }>
  >(Prisma.sql`
    SELECT date_trunc('month', j."scheduledAt") AS month,
           COUNT(*)::bigint AS jobs,
           SUM(${CLIENT_PENCE})::bigint AS revenue,
           SUM(${COST_PENCE})::bigint AS costs
    ${jobSource(filters)}
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  return rows.map((row) => {
    const revenuePence = Number(row.revenue ?? 0);
    const costsPence = Number(row.costs ?? 0);
    return {
      month: row.month.toISOString().slice(0, 7),
      jobs: Number(row.jobs),
      revenuePence,
      profitPence: revenuePence - costsPence,
    };
  });
}

export interface DetailRow {
  id: string;
  reference: string;
  scheduledAt: Date;
  jobType: string;
  status: string;
  clientName: string | null;
  accountName: string | null;
  driverName: string | null;
  registration: string | null;
  pickupText: string;
  dropoffText: string;
  revenuePence: number;
  costsPence: number;
  profitPence: number;
}

/**
 * The jobs behind the totals — spec 4.6.6.
 *
 * Server-paginated. The whole point of the aggregates above is that nobody
 * ever loads a year of rows, and a detail table that did would undo it.
 */
export async function reportDetail(
  filters: ReportFilters,
  page: { skip: number; take: number },
): Promise<{ rows: DetailRow[]; total: number }> {
  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        scheduledAt: Date;
        jobType: string;
        status: string;
        clientName: string | null;
        accountName: string | null;
        driverName: string | null;
        registration: string | null;
        pickupText: string;
        dropoffText: string;
        revenue: bigint | null;
        costs: bigint | null;
      }>
    >(Prisma.sql`
      SELECT j.id,
             j."reference",
             j."scheduledAt",
             j."jobType"::text AS "jobType",
             j."status"::text AS status,
             c."name" AS "clientName",
             a."name" AS "accountName",
             d."name" AS "driverName",
             v."registration" AS registration,
             j."pickupText",
             j."dropoffText",
             ${CLIENT_PENCE}::bigint AS revenue,
             ${COST_PENCE}::bigint AS costs
      ${JOB_FROM}
      LEFT JOIN "Client" c ON c.id = j."clientId"
      LEFT JOIN "Account" a ON a.id = j."accountId"
      LEFT JOIN "Driver" d ON d.id = j."driverId"
      LEFT JOIN "Vehicle" v ON v.id = j."vehicleId"
      ${jobWhere(filters)}
      ORDER BY j."scheduledAt" DESC, j."reference" DESC
      LIMIT ${page.take} OFFSET ${page.skip}
    `),
    prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total ${jobSource(filters)}
    `),
  ]);

  return {
    rows: rows.map((row) => {
      const revenuePence = Number(row.revenue ?? 0);
      const costsPence = Number(row.costs ?? 0);
      return {
        id: row.id,
        reference: row.reference,
        scheduledAt: row.scheduledAt,
        jobType: row.jobType,
        status: row.status,
        clientName: row.clientName,
        accountName: row.accountName,
        driverName: row.driverName,
        registration: row.registration,
        pickupText: row.pickupText,
        dropoffText: row.dropoffText,
        revenuePence,
        costsPence,
        profitPence: revenuePence - costsPence,
      };
    }),
    total: Number(counted[0]?.total ?? 0),
  };
}

/** Rows for the spreadsheet export, already human-readable. */
export function toDetailExportRows(rows: DetailRow[]) {
  return rows.map((row) => ({
    Reference: row.reference,
    Date: row.scheduledAt.toISOString().slice(0, 10),
    Type: row.jobType,
    Status: row.status,
    Client: row.clientName ?? '',
    Account: row.accountName ?? '',
    Driver: row.driverName ?? '',
    Vehicle: row.registration ?? '',
    From: row.pickupText,
    To: row.dropoffText,
    Revenue: row.revenuePence / 100,
    Cost: row.costsPence / 100,
    Profit: row.profitPence / 100,
  }));
}

export function toBreakdownExportRows(rows: BreakdownRow[]) {
  return rows.map((row) => ({
    Name: row.label,
    Jobs: row.jobs,
    Revenue: row.revenuePence / 100,
    Cost: row.costsPence / 100,
    Profit: row.profitPence / 100,
    // Blank rather than 0 when there was no revenue: a margin on nothing is
    // undefined, and printing 0% would read as break-even.
    'Margin %': row.marginPct ?? '',
  }));
}

/**
 * The filters, written out — spec 4.6.7 wants them printed on the export.
 *
 * A spreadsheet of numbers with no statement of what was included is one
 * somebody will read as the whole business.
 */
export function describeFilters(
  filters: ReportFilters,
  names: Partial<Record<'driver' | 'client' | 'account' | 'vehicle', string>> = {},
): string {
  const parts = [
    `${filters.from.toISOString().slice(0, 10)} to ${filters.to.toISOString().slice(0, 10)}`,
  ];

  if (names.driver) parts.push(`driver ${names.driver}`);
  if (names.client) parts.push(`client ${names.client}`);
  if (names.account) parts.push(`account ${names.account}`);
  if (names.vehicle) parts.push(`vehicle ${names.vehicle}`);
  if (filters.jobType) parts.push(`type ${filters.jobType}`);
  parts.push(
    filters.status ? `status ${filters.status}` : 'all statuses except cancelled',
  );

  return parts.join(' · ');
}
