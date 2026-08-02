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

## Contents

```
CLAUDE.md                              project context — stack, conventions, guardrails
README.md                              this file
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
