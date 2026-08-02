# WeLux Ops — Build Specification

A complete specification pack for rebuilding the WeLux Chauffeurs job management system in Next.js + Postgres.

## How to use this with Claude Code

1. Create an empty repo and copy this whole folder into it.
2. Open Claude Code in the repo root. It reads `CLAUDE.md` automatically.
3. Work one phase at a time:
   ```
   Read docs/specs/phase-0-foundation.md and implement it.
   Work through the acceptance criteria in order and write a test for each.
   Stop when all criteria pass — do not start Phase 1.
   ```
4. Review, commit, then move to the next phase.

**Do not paste all seven phases in at once.** The output will look plausible and be shallow. Each phase is sized to be built, reviewed and committed as a unit.

## Build order

The order below differs deliberately from the enhancement roadmap in the original audit. That roadmap assumed you were adding features to a running system. On a rebuild you have to build the foundations first, and the highest-value features arrive later but land on solid ground.

| Phase | Scope | Depends on |
|---|---|---|
| **0 — Foundation** | Repo, DB, auth, roles, layout, deploy pipeline, audit log | — |
| **1 — Core records** | Clients, accounts, drivers, vehicles, documents, expiry tracking | 0 |
| **2 — Jobs** | Job CRUD, list with server-side filters, statuses, price at booking, finance panel | 1 |
| **3 — Branding & import** | White-label theming, install script, CSV import for drivers/vehicles/clients | 2 |
| **4 — Money** | Rate cards, invoicing with VAT, invoice ledger, driver payouts, reports and exports | 3 |
| **5 — Telegram** | Driver bot, assignment, status events, wait-time capture, expenses, admin bot | 4 |
| **6 — Dispatch & scale** | Day timeline, conflict detection, recurring jobs, saved locations, payment gateways | 5 |

Phases 0–3 get you a branded, usable system with expiry tracking and real pricing. Phases 4–6 are where it overtakes the legacy one.

## Local setup

Ten steps, assuming Node 20+ and a Postgres 16 database you can reach
(Supabase, Neon or local).

1. `npm install`
2. `cp .env.example .env`
3. Set `DATABASE_URL` to the **pooled** connection string and `DIRECT_URL` to
   the direct one. On Supabase these are the port 6543 and port 5432 URLs —
   Prisma Migrate cannot run through pgbouncer, which is why there are two.
4. Set `AUTH_SECRET` — `openssl rand -base64 32`
5. Set `CRON_SECRET` — `openssl rand -hex 32`
6. `npm run db:migrate` — applies `prisma/migrations` to the database
7. `npm run db:seed` — creates the admin user, the London zones and a default
   rate card. The generated admin password is printed once; save it.
8. `npm run dev`
9. Open <http://localhost:3000> and sign in as the seeded admin
10. `npm run typecheck && npm run lint && npm run test` should be clean

R2 credentials are only needed once document upload arrives in Phase 1; the
app runs without them.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build (runs `prisma generate` first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the no-hex-colours rule |
| `npm run test` | Vitest. Database-backed suites skip unless `TEST_DATABASE_URL` is set |
| `npm run test:e2e` | Playwright. Needs a database and seeded users |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:deploy` | `prisma migrate deploy` — what Vercel runs |
| `npm run db:seed` | Idempotent seed |
| `npm run db:studio` | Prisma Studio |
| `npm run verify` | Preflight check on a new install — connection, migrations, seed |

### Running the database-backed tests

The soft-delete and audit guarantees are only meaningful against real
Postgres, so those suites skip by default:

```bash
TEST_DATABASE_URL=postgresql://…/scratch_db npm run test
```

Point it at a scratch database — the suites create and delete rows.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- **static** — typecheck, lint, unit tests
- **database** — spins up Postgres 16, applies `prisma/migrations` to an empty
  database, seeds it, and runs the suite with `TEST_DATABASE_URL` set, so the
  soft-delete and audit guarantees are proven rather than assumed
- **e2e** — Playwright against a real build with seeded users
- **white-label** — greps application code for a customer name and fails if it
  appears outside `docs/` and `reference/`

The database job is the one that matters: it is where the migration is proven
to apply cleanly, which is otherwise only discovered on a real deploy.

## Deployment

Vercel plus Supabase, one install per customer. Full runbook, including the
two-connection-string setup and the failure modes it prevents, is in
[`docs/deployment.md`](docs/deployment.md).

The short version:

1. Create the Supabase project; copy **both** connection strings — pooled
   (6543, with `?pgbouncer=true`) for `DATABASE_URL`, direct (5432) for
   `DIRECT_URL`. Migrations cannot run through pgbouncer, which is why there
   are two
2. `npm run db:deploy && npm run db:seed`, then `npm run verify`
3. Import into Vercel; set the same variables plus `AUTH_SECRET` and
   `CRON_SECRET`
4. Deploy — `vercel.json` applies migrations as part of the build
5. Check `/api/health` returns `{"status":"ok","database":"ok"}`

Preview deployments should get their own branch database so a preview never
migrates production.

## Contents

```
CLAUDE.md                              project context — stack, conventions, guardrails
README.md                              this file
app/
  (auth)/                              login
  (dashboard)/                         the application shell and its sections
  api/                                 auth, health, cron
components/
  ui/                                  shadcn/ui primitives
  layout/                              shell, sidebar, user menu
lib/
  money.ts                             pence <-> display, never float
  dates.ts                             UTC <-> configured timezone
  prisma.ts                            client with the soft-delete extension
  audit.ts                             transactional audit log
  auth.ts  auth-adapter.ts  permissions.ts  authz.ts
  storage.ts                           R2
prisma/
  schema.prisma
  migrations/
  seed.ts
docs/
  data-model.md                        full Prisma schema with rationale
  api-spec.md                          route contracts
  specs/
    phase-0-foundation.md
    phase-1-core-records.md
    phase-2-jobs.md
    phase-3-branding-and-import.md
    phase-4-money.md
    phase-5-telegram.md
    phase-6-dispatch.md
reference/
  legacy-system-audit.md               how the old system worked, and why this one differs
tests/
  e2e/                                 Playwright
```

`reference/` is background, not build instructions. It records how the legacy system behaved and what was wrong with it — useful when a spec decision looks arbitrary, but Claude Code should build from `docs/`, not from it.

## Decisions already made

- **Fresh start.** Empty database, no legacy data migration. Existing drivers, vehicles and clients load via CSV import.
- **White label = theming.** Logo, colours and company details are configurable. Functionality is identical across installs.
- **One install per company.** Separate deployment, separate database. No tenant IDs, no shared data, no multi-tenant code.
- **Next.js 15 + PostgreSQL + Prisma**, deployed on Vercel with Cloudflare R2 for files
- **Telegram for drivers**, email/SMS for clients (UK Telegram penetration is too low to ask clients to install it)
- **UK defaults held as configuration** — GBP, Europe/London, VAT 20%, PHV/MOT document types — so a non-UK install is a settings change, not a rewrite

## Decisions still needed

Flag these before or during the phase in question:

| Decision | Needed by | Notes |
|---|---|---|
| Hosting and Postgres provider | Phase 0 | Vercel + Neon/Supabase assumed |
| VAT registration status and rate | Phase 4 | Assumed registered at 20% standard rate |
| Rate card structure — actual zones and prices | Phase 4 | Needs the real commercial rates from the business |
| Free waiting-time allowance per job type | Phase 5 | Assumed 45 min airport / 15 min other |
| Whether drivers are self-employed subcontractors | Phase 4 | Affects payout statement wording and any CIS/VAT treatment |
| How long the legacy system stays available | — | Keep it read-only for reference; nothing reads from it programmatically |

## The three things that matter most

If scope has to be cut, protect these:

1. **Price captured at booking** (Phase 2) — makes reporting real
2. **Document expiry tracking** (Phase 1) — protects the operator licence
3. **Telegram status buttons** (Phase 5) — makes item 1 nearly automatic and turns wait time into billable revenue
