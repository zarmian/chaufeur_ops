/**
 * Proves the Phase 2 performance requirement: the job list, its filters and
 * its sorts all respond in under 500ms at 10,000 jobs.
 *
 * The number is not decoration. The legacy Overview rendered 704 rows at once
 * and got slower every week, and the difference between working pagination
 * and a missing index is invisible until the table is big. So this is run
 * against a seeded volume rather than being assumed:
 *
 *   SEED_JOB_COUNT=10000 npm run db:seed
 *   npm run perf:jobs
 *
 * Exits non-zero if any query is over budget, so CI can gate on it.
 */

import { listJobs } from '../lib/jobs';

const params = (over = {}) => ({
  page: 1, pageSize: 50, skip: 0, take: 50, q: null,
  sort: null as string | null, dir: 'asc' as const, ...over,
});
const none = {
  status: null, jobType: null, driverId: null, clientId: null,
  accountId: null, vehicleId: null, from: null, to: null, unpricedOnly: false,
};

async function time(label: string, fn: () => Promise<unknown>) {
  await fn(); // warm
  const runs: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t = performance.now();
    await fn();
    runs.push(performance.now() - t);
  }
  const worst = Math.max(...runs);
  const median = runs.sort((a, b) => a - b)[2]!;
  console.log(
    `${worst < 500 ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} median ${median.toFixed(0)}ms  worst ${worst.toFixed(0)}ms`,
  );
  return worst < 500;
}

async function main() {
  const results = [
    await time('default list (page 1)', () => listJobs(params(), none)),
    await time('deep page (page 150)', () =>
      listJobs(params({ page: 150, skip: 7450 }), none)),
    await time('unpriced filter + count', () =>
      listJobs(params(), { ...none, unpricedOnly: true })),
    await time('status filter', () =>
      listJobs(params(), { ...none, status: 'COMPLETED' })),
    await time('date range (90 days)', () =>
      listJobs(params(), { ...none, from: '2026-06-01', to: '2026-08-30' })),
    await time('text search', () =>
      listJobs(params({ q: 'Heathrow' }), none)),
    await time('sort by gross profit', () =>
      listJobs(params({ sort: 'grossProfit', dir: 'desc' }), none)),
    await time('sort by client name', () =>
      listJobs(params({ sort: 'client', dir: 'asc' }), none)),
    await time('combined: unpriced + search + sort', () =>
      listJobs(params({ q: 'Dorchester', sort: 'scheduledAt', dir: 'desc' }),
        { ...none, unpricedOnly: true })),
  ];
  console.log(results.every(Boolean) ? '\nAll under 500ms.' : '\nSOME OVER BUDGET.');
  process.exit(results.every(Boolean) ? 0 : 1);
}
main();
