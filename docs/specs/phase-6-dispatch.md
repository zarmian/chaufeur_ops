# Phase 6 — Dispatch and Scale

**Goal:** turn a job list into a dispatch tool, and remove the remaining repetitive work.

**Depends on:** Phase 5 — the timeline is far more useful once driver status events flow in live.

---

## 6.1 Dispatch day view

**Acceptance criteria**
1. Horizontal timeline: drivers down the left, hours across the top, one row per driver
2. Jobs render as blocks positioned by `scheduledAt`, width from estimated duration
3. Block colour encodes status: grey pending, blue assigned, amber accepted, green in progress, dark green completed, red cancelled or no-show
4. Date picker with today, tomorrow and next-7-days shortcuts
5. An unassigned column holds jobs with no driver, ordered by pickup time
6. Drag a job onto a driver row to assign, with compliance and conflict checks applied on drop
7. Hovering a block shows the full brief
8. Clicking opens the job detail
9. Live refresh every 30 seconds, or push updates via SSE
10. "Now" marker on the timeline
11. Drivers with no jobs that day are collapsible
12. Renders in under one second with 40 drivers and 120 jobs

## 6.2 Conflict detection

**Acceptance criteria**
1. `findConflicts(driverId, scheduledAt, estimatedMinutes, excludeJobId?)` returns overlapping jobs
2. A configurable buffer (default 60 minutes) accounts for travel between jobs
3. Conflicts warn on job create, edit and dispatch drag — they never hard-block, because ops sometimes knows better
4. The warning names the conflicting job with a link
5. The same check runs for vehicles
6. The dispatch view outlines conflicting blocks in red
7. A daily digest lists tomorrow's conflicts

## 6.3 Recurring and linked jobs

**Acceptance criteria**
1. "Create return journey" from a job pre-fills a new one with pickup and dropoff swapped and a suggested return time
2. Return jobs link to the outbound job and both display the link
3. Recurring jobs: daily, weekly on chosen days, or monthly, with an end date or occurrence count
4. Generating a recurrence creates individual jobs, each independently editable
5. Editing a recurrence offers "this job only" or "this and future"
6. Cancelling a series offers the same choice
7. Recurring series are visible and manageable from a dedicated view

## 6.4 Saved locations

**Acceptance criteria**
1. Location CRUD with label, address, postcode, zone, airport flag
2. Autocomplete on pickup and dropoff, ordered by `useCount` then alphabetically
3. Free text is still accepted, with a "save as location" prompt for repeat entries
4. Bulk-create from the migrated data's most frequent pickup and dropoff strings
5. Airport terminals seeded for Heathrow T2–T5, Gatwick N and S, Luton, Stansted and City
6. Client records may hold favourite locations, offered first for that client

## 6.5 Bulk operations

**Acceptance criteria**
1. Multi-select in the job list with a bulk action bar
2. Bulk assign driver, bulk set status, bulk set prices, bulk add to invoice
3. Every bulk action applies the same validation per job and reports per-job success or failure
4. Bulk actions above 50 jobs run as a background job with progress feedback
5. All bulk actions are audited individually, not as a single entry

## 6.6 Dashboard

**Acceptance criteria**
1. Tiles: jobs today, jobs this week, unassigned in the next 24h, completed unpriced, documents expiring, invoices overdue, revenue this month, gross profit this month
2. Each tile links to the relevant filtered view
3. Tiles turn amber or red against configurable thresholds
4. Revenue chart for the last 12 months
5. Top clients and top drivers by revenue for the current period
6. Tiles are role-filtered — `OPS` does not see revenue tiles

## 6.7 Performance and hardening

**Acceptance criteria**
1. Job list under 500 ms at 50,000 jobs
2. Dispatch view under 1 s at 40 drivers and 120 jobs
3. Reports under 3 s over a 12-month range
4. `EXPLAIN ANALYZE` reviewed on every list and report query; no sequential scans on `jobs`
5. Rate limiting on auth, exports and the webhook
6. Errors captured to Sentry or equivalent, with user context
7. Automated daily database backups with a tested restore
8. Uptime monitoring against `/api/health`

**Measured** — `npm run perf:phase6`, against 50,361 jobs, 34,975 finance
rows and 520 active drivers on Postgres 16. Worst of five runs after a warm-up:

| | Worst | Budget |
|---|---|---|
| Job list, page 1 | 15 ms | 500 ms |
| Job list, page 200 | 18 ms | 500 ms |
| Job list, unpriced filter | 14 ms | 500 ms |
| Dispatch day | 19 ms | 1000 ms |
| Dispatch day, all drivers | 13 ms | 1000 ms |
| Report summary, 12 months | 63 ms | 3000 ms |
| Report breakdown by client | 69 ms | 3000 ms |
| Report trend, 12 months | 60 ms | 3000 ms |
| Dashboard | 375 ms | 2000 ms |

`EXPLAIN` on the four representative shapes — by date, by status and date,
one driver over a day, one vehicle over a day — shows an index scan on each;
the script fails if any of them plans a sequential scan on `Job`.

The dashboard is the slowest and by a long way, which is expected: it is ten
queries where the others are two or three. It is inside budget because those
ten run in parallel, and the thing to watch for in review is somebody making
them sequential.

Seed the volume with
`SEED_DRIVER_COUNT=200 SEED_JOB_COUNT=50000 npm run db:seed`.

---

## Definition of done

- All acceptance criteria pass
- Load-tested at 50,000 jobs and 200 drivers
- Ops team has used the dispatch view for a full week and signed it off
- Performance budgets met and recorded

---

# Beyond Phase 6

Not specified here, but the natural next steps once the above is live:

| Idea | Why |
|---|---|
| **Client booking portal** | Corporate accounts book themselves; removes manual entry entirely |
| **Automated dispatch suggestions** | Rank available drivers by proximity, compliance and workload |
| **Driver ratings and incident log** | Quality management across ~195 subcontractors |
| **Xero / QuickBooks sync** | Replaces the export-and-import cycle |
| **Real-time client tracking link** | A public link showing driver position, from data already captured in 5.7 |
| **Demand forecasting** | Two years of job history predicts staffing needs by day and hour |
| **Fuel and mileage tracking** | Genuine per-vehicle running costs against per-job profitability |
