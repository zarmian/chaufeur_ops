# WeLux Ops — Project Context

Read this before writing any code. It defines the stack, the conventions and the rules that must not be broken.

## What this is

A job management system for chauffeur and private hire operators. It tracks jobs, drivers, vehicles, compliance documents, per-job profitability, client invoicing and driver payouts.

The first customer is a UK chauffeur company running ~195 owner-drivers, each with an assigned vehicle, doing airport transfers, point-to-point transfers and "as directed" hourly hire around London. There is now a second customer on a second install.

**This is a white-label product.** Each customer gets their **own install** — separate deployment, separate database. There is no multi-tenancy: no tenant IDs, no shared data, no cross-company logic. White label means logo, colours and company details are configuration; the functionality is identical everywhere.

**More than one customer does not change that.** The question has been asked and answered once already: a second company means a second install, not a tenant column. Two customers' rows never share a table, so no query can return the wrong company's data by forgetting a `where`, and one customer's bad release cannot take the other offline. The cost is real — two deployments to release to and two databases to migrate, which `docs/deployment.md` covers — and it is much smaller than the cost of getting isolation wrong once in front of a paying customer.

If shared data is ever genuinely needed — one operator subcontracting to another, a driver working for both — that is a different product decision and a far larger piece of work. It must be decided deliberately, not arrived at by adding "just one" `tenantId`.

**Fresh start.** The database begins empty. There is no legacy data migration. Existing records load through CSV import (Phase 3).

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript strict | Server Components by default; Client Components only where interactivity requires it |
| Database | PostgreSQL 16 | |
| ORM | Prisma | Migrations checked into `prisma/migrations` |
| Auth | Email/password over argon2id, **database sessions** (`lib/session.ts`) | Roles enforced server-side, never only in the UI |
| UI | Tailwind CSS + shadcn/ui | |
| Forms | react-hook-form + Zod | The same Zod schema validates client and server |
| Tables | TanStack Table, **server-side** pagination and filtering | Never load a full table into the client |
| File storage | Vercel Blob, private | Never store binaries in Postgres; reads go through short-lived signed URLs |
| PDF | Puppeteer (invoices, driver statements) | Render from an HTML template |
| Spreadsheet | SheetJS | Exports only |
| Telegram | grammY | Webhook mode, not polling |
| Scheduled work | Vercel Cron → authenticated route handlers | Expiry chasing, weekly statements, overdue reminders |
| Testing | Vitest (unit), Playwright (E2E) | |

## Non-negotiable conventions

### Money
**All monetary values are integers in pence.** Column names end `_pence`. Never use `Float` or `Decimal` for money. Format at the edge only, via `formatGBP()` in `lib/money.ts`. `12550` renders as `£125.50`.

### Dates and times
**Store `timestamptz` in UTC. Display in `Europe/London`.** This is a UK operation and British Summer Time will produce wrong pickup times if ignored. Never store a naive local datetime. Job pickup is a single `scheduled_at timestamptz` — not separate date and time columns.

### Deletes
**Soft delete only.** Every primary entity has `deleted_at`, filtered out by Prisma middleware. There is no hard delete in the application layer.

### Audit
Every create, update and delete on `jobs`, `job_finances`, `invoices`, `drivers`, `vehicles` and `clients` writes to `audit_log` with the acting user, a before snapshot and an after snapshot. Not optional — the legacy system's lack of attribution is one of the problems being solved.

### Money must never be silently zero
A job with no client price is a data-quality defect, not a free job. The UI surfaces unpriced jobs everywhere, and the API refuses to mark a job `COMPLETED` without either a client price or an explicit `zero_value_reason`.

### Sessions live in the database

Auth.js v5 was the original choice, but it cannot deliver a credentials
provider *and* database sessions together: under `strategy: 'database'` it
never runs the `jwt` callback for credentials, so no session row is created
and the cookie holds a JWT the adapter cannot resolve. The Phase 0 E2E run
caught it — sign-in set a cookie and every page then bounced to `/login`.

Between the two constraints, the behaviour won. Sessions exist in Postgres
so that deactivating a user takes effect on their **next request**, not
whenever a token happens to expire. `lib/session.ts` owns issue, resolve and
revoke; the cookie carries a random token and the table stores only its
SHA-256 hash. There is no signing secret to configure or leak.

Do not reintroduce a JWT session strategy for convenience.

### Server-side authority
Prices, totals, gross profit and status transitions are computed and validated **on the server**. The client may show a calculated total for feedback, but never sends a total the server trusts.

### No hardcoded company identity
Nothing in the codebase names a specific customer. Trading name, logo, brand colours, job and invoice reference prefixes, email sender, PDF letterhead and support contacts all come from settings. **No hex colour literals in component code** — brand colours reach components as CSS custom properties, so `bg-primary` follows configuration. CI greps for the first customer's name and fails if it appears outside seed fixtures.

### Locale as configuration, not constants
Currency, locale, timezone, tax name and rate, and distance unit are settings with UK defaults (GBP, `en-GB`, `Europe/London`, VAT 20%, miles). Money renders through `Intl.NumberFormat` with the configured currency. Never hardcode `£`, `Europe/London` or `20`.

## Roles

| Role | Can |
|---|---|
| `ADMIN` | Everything, including users, settings and deletes |
| `OPS` | Jobs, drivers, vehicles, dispatch, documents. Read-only on invoices and payouts |
| `ACCOUNTS` | Job finances, invoices, payouts, reports. Read-only on operational job fields |
| `VIEWER` | Read-only throughout |

Drivers are **not** users. They have no dashboard login and interact only through the Telegram bot.

## Domain rules that are easy to get wrong

1. **Booker ≠ client.** The client rides. The booker (`Account` in the schema) placed the booking and is usually who gets invoiced — sometimes WeLux itself, sometimes a partner agency, sometimes an individual. Separate entities; either can be the invoice recipient.

2. **Job types price differently.** `TRANSFER` and `AIRPORT_TRANSFER` are fixed-fare. `AS_DIRECTED` is hourly (`customer_hours × customer_rate`) with a minimum-hours rule. The rate card handles both.

3. **Wait time is revenue.** The gap between the driver's `ARRIVED` and `POB` events is billable above a free allowance (default 45 min for airport arrivals, 15 min otherwise — configurable). Calculated from `job_events`, never typed by hand.

4. **A driver has one assigned vehicle, but a job may override it.** Never assume `job.vehicle_id == driver.assigned_vehicle_id`.

5. **Expired documents block assignment.** A driver with a lapsed PHV badge, or a vehicle with a lapsed MOT or insurance, cannot be assigned to a job with a future pickup. Licensing requirement, not a preference.

6. **Invoices are immutable once sent.** Changing a `SENT` or `PAID` invoice requires a credit note, not a mutation.

## Repository layout

```
app/
  (auth)/                    login
  (dashboard)/
    jobs/                    list, detail, new
    dispatch/                day timeline view
    drivers/  vehicles/  clients/  accounts/
    invoices/ payouts/  reports/  settings/
  api/
    telegram/webhook/
    cron/
lib/
  money.ts                   pence <-> display, never float
  dates.ts                   UTC <-> Europe/London
  pricing/                   rate card resolution
  audit.ts
  auth.ts
  telegram/                  grammY bot, handlers, keyboards
prisma/
  schema.prisma
  migrations/
docs/
  data-model.md  api-spec.md
  specs/                     one file per build phase
scripts/
  setup.ts                   first-run install wizard
  import/                    CSV import parsers and validators
```

## How to work on this

- Build **one phase at a time**, in the order in `README.md`. Do not start a later phase before the previous one's acceptance criteria pass.
- Every feature in `docs/specs/` has numbered acceptance criteria. Implement against them and write the test that proves each one.
- Run `npx prisma migrate dev` for schema changes; never edit the database by hand.
- Before marking a phase done, run the full test suite and the type check.

## Guardrails

- Do not add dependencies beyond those listed without flagging it first.
- Do not write raw SQL where Prisma will do, except in reporting aggregates where it is clearer — and then parameterised only.
- No secrets in the repo. Everything via `.env`, with `.env.example` kept current.
- Do not weaken the money-as-pence, UTC-storage, soft-delete or audit rules for convenience. They exist because their absence in the legacy system is the reason for this rebuild.
