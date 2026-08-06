/**
 * The Phase 6.7 performance budgets, measured rather than assumed.
 *
 * Three claims, and each has a number the spec gives:
 *
 *   - the job list under 500ms at 50,000 jobs (6.7.1)
 *   - the dispatch view under 1s at 40 drivers and 120 jobs (6.7.2)
 *   - reports under 3s over a twelve-month range (6.7.3)
 *
 * And one claim that is not about time at all: no sequential scan on `jobs`
 * (6.7.4). That is the one worth automating, because a missing index looks
 * fine on a small table and only shows up when the table is big — which is
 * exactly when nobody is in a position to fix it calmly.
 *
 * Run against a loaded database:
 *
 *   SEED_DRIVER_COUNT=200 SEED_JOB_COUNT=50000 npm run db:seed
 *   npm run perf:phase6
 *
 * Exits non-zero if anything is over budget or scanning sequentially, so CI
 * can gate on it.
 */

import { loadDashboard } from '../lib/dashboard';
import { loadDispatchDay } from '../lib/dispatch';
import { listJobs } from '../lib/jobs';
import { prisma } from '../lib/prisma';
import { reportBreakdown, reportSummary, reportTrend } from '../lib/reports';

const params = (over = {}) => ({
  page: 1,
  pageSize: 50,
  skip: 0,
  take: 50,
  q: null,
  sort: null as string | null,
  dir: 'asc' as const,
  ...over,
});

const noFilters = {
  status: null,
  jobType: null,
  driverId: null,
  clientId: null,
  accountId: null,
  vehicleId: null,
  from: null,
  to: null,
  unpricedOnly: false,
};

const reportFilters = {
  from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
  to: new Date(),
  clientId: null,
  accountId: null,
  driverId: null,
  vehicleId: null,
  jobType: null,
};

async function time(
  label: string,
  budgetMs: number,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  await fn(); // warm, so the first-call connection cost is not the measurement

  const runs: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await fn();
    runs.push(performance.now() - started);
  }

  const worst = Math.max(...runs);
  const median = runs.slice().sort((a, b) => a - b)[2]!;
  const ok = worst < budgetMs;

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} median ${median.toFixed(0)}ms  worst ${worst.toFixed(0)}ms  (budget ${budgetMs}ms)`,
  );
  return ok;
}

/**
 * Spec 6.7.4 — no sequential scan on `Job`.
 *
 * `EXPLAIN` rather than `EXPLAIN ANALYZE`: the plan is the claim, and running
 * the query twice to check how it was run is a waste when the planner has
 * already said.
 *
 * A sequential scan on a small table is correct and not worth failing over,
 * so this only judges plans against a table big enough for the choice to
 * mean something.
 */
async function planIsIndexed(label: string, sql: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
    `EXPLAIN ${sql}`,
  );
  const plan = rows.map((row) => Object.values(row)[0] ?? '').join('\n');

  // Only a scan of `Job` itself matters. A sequential scan of a tiny lookup
  // table is the right plan and failing on it would make the check noise.
  const sequential = /Seq Scan on "?Job"?/i.test(plan);

  console.log(`${sequential ? 'FAIL' : 'PASS'}  ${label.padEnd(44)} ${sequential ? 'sequential scan on Job' : 'index used'}`);
  if (sequential) console.log(plan);
  return !sequential;
}

async function main() {
  const jobs = await prisma.job.count();
  const drivers = await prisma.driver.count({ where: { status: 'ACTIVE' } });

  console.log(`Against ${jobs} jobs and ${drivers} active drivers.\n`);

  if (jobs < 10_000) {
    console.log(
      'NOTE: fewer than 10,000 jobs. The timings below say little, and the\n' +
        'planner will legitimately prefer a sequential scan on a small table.\n' +
        'Seed the volume first:\n' +
        '  SEED_DRIVER_COUNT=200 SEED_JOB_COUNT=50000 npm run db:seed\n',
    );
  }

  console.log('Timings');
  const timings = [
    await time('job list, page 1', 500, () => listJobs(params(), noFilters)),
    await time('job list, deep page', 500, () =>
      listJobs(params({ page: 200, skip: 9_950 }), noFilters),
    ),
    await time('job list, unpriced filter', 500, () =>
      listJobs(params(), { ...noFilters, unpricedOnly: true }),
    ),
    await time('dispatch day', 1000, () => loadDispatchDay(new Date())),
    await time('dispatch day, all drivers', 1000, () =>
      loadDispatchDay(new Date(), { includeEmptyDrivers: true }),
    ),
    await time('report summary, 12 months', 3000, () =>
      reportSummary(reportFilters),
    ),
    await time('report breakdown by client', 3000, () =>
      reportBreakdown(reportFilters, 'client'),
    ),
    await time('report trend, 12 months', 3000, () => reportTrend(reportFilters)),
    await time('dashboard', 2000, () => loadDashboard({ seesMoney: true })),
  ];

  console.log('\nPlans');
  const plans =
    jobs < 10_000
      ? [true]
      : [
          await planIsIndexed(
            'job list by date',
            `SELECT id FROM "Job" WHERE "deletedAt" IS NULL ORDER BY "scheduledAt" DESC LIMIT 50`,
          ),
          await planIsIndexed(
            'job list by status and date',
            `SELECT id FROM "Job" WHERE "deletedAt" IS NULL AND status = 'COMPLETED' ORDER BY "scheduledAt" DESC LIMIT 50`,
          ),
          await planIsIndexed(
            'one driver, one day',
            `SELECT id FROM "Job" WHERE "driverId" IS NOT NULL AND "scheduledAt" BETWEEN NOW() AND NOW() + INTERVAL '1 day' LIMIT 50`,
          ),
          await planIsIndexed(
            'one vehicle, one day',
            `SELECT id FROM "Job" WHERE "vehicleId" IS NOT NULL AND "scheduledAt" BETWEEN NOW() AND NOW() + INTERVAL '1 day' LIMIT 50`,
          ),
        ];

  const passed = [...timings, ...plans].every(Boolean);
  console.log(passed ? '\nAll within budget.' : '\nSOMETHING IS OVER BUDGET.');

  await prisma.$disconnect();
  process.exit(passed ? 0 : 1);
}

void main();
