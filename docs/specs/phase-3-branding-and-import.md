# Phase 3 — Branding and Data Import

*(This file replaces the earlier legacy-migration phase. There is no data migration — every install starts empty.)*

**Goal:** make the system re-skinnable for a new customer by changing settings rather than code, and give a fresh install a way to load its drivers, vehicles and clients without typing 400 records by hand.

**Depends on:** Phase 2.

**Deployment model:** one install per company — separate deployment, separate database. There is no tenant ID, no shared data and no cross-company logic anywhere. White label here means colours, logo and company details.

---

## 3.1 Branding settings

**Acceptance criteria**
1. Settings → Branding page, `ADMIN` only
2. Fields: trading name, legal name, logo (light background), logo (dark background), favicon, primary colour, accent colour, company address, phone, support email, VAT number, company registration number, bank details for invoices, job reference prefix
3. Logo and favicon upload to R2 with the same validation as documents; SVG and PNG accepted
4. Colours entered as hex with a picker; a live preview panel shows a sample button, badge and table row
5. Contrast between each colour and its foreground is checked against WCAG AA; a failing combination warns before saving
6. Saving takes effect immediately — no rebuild or redeploy
7. Values are cached and revalidated on save, not read from the database on every request

## 3.2 Theming

**Acceptance criteria**
1. Brand colours are exposed as CSS custom properties on `:root`, written by the root layout from settings
2. Tailwind and shadcn/ui theme tokens resolve to those variables — `bg-primary` follows the configured colour with no component changes
3. Derived shades (hover, active, muted, ring) are computed from the base colour, so one hex value produces a coherent palette
4. **No hex colour literals in component code.** A lint rule or CI grep enforces it, with an allowlist for semantic states like error red and success green
5. The logo renders in the sidebar, on the login page, on invoice and statement PDFs, and in email templates
6. Dark mode uses the dark-background logo variant
7. Falls back to a neutral default theme when branding is unset, so a fresh install is usable before configuration

## 3.3 No hardcoded company identity

The test of a white-label build is that nothing says WeLux unless a setting does.

**Acceptance criteria**
1. Job reference prefix comes from settings — `WLX-000123` for one install, `ACME-000123` for another
2. Invoice number prefix likewise
3. Page titles, email subjects and sender names, PDF headers and footers all read from settings
4. Telegram bot token and bot name are per-install configuration
5. CI check: no occurrence of `WeLux` (case-insensitive) anywhere outside seed fixtures and this documentation
6. The seed script's example company is generic, not WeLux

## 3.4 Install and provisioning

**Acceptance criteria**
1. `npm run setup` runs an interactive first-time script capturing company details, the first admin user, currency, timezone, tax name and rate, distance unit and reference prefix
2. It seeds document types, standard zones and a default rate card
3. It is safe to re-run — it detects an already-configured install and exits rather than overwriting
4. A deployment runbook documents standing up a new customer end to end: provision database, set environment variables, deploy, run setup, configure branding, create users
5. Target: a new install live and branded in under an hour

## 3.5 CSV import

Every fresh install needs its existing drivers, vehicles and clients loaded. WeLux alone has roughly 195 of each.

**Acceptance criteria**
1. Import available for drivers, vehicles and clients
2. Each entity offers a template CSV download with correct headers and an example row
3. Upload shows a preview of the first 20 parsed rows before anything is written
4. Validation runs across the whole file first, producing a per-row error report identifying the row number and the problem
5. Valid rows import even when others fail — the report lists what was skipped and why
6. Idempotent on a natural key: registration for vehicles, phone for drivers, normalised name plus contact for clients. A re-import updates rather than duplicates.
7. Vehicles may be referenced by registration in the driver file, linking the two in one pass
8. Document expiry dates import where present; blank dates land in the compliance backlog rather than being treated as valid
9. Import writes an audit entry recording the file name, row counts and the user
10. A completed import shows a summary: created, updated, skipped, with the error report downloadable

## 3.6 Localisation configuration

UK defaults, held as configuration rather than constants, so a non-UK install is a settings change rather than a rewrite.

**Acceptance criteria**
1. Settings hold currency (ISO 4217), locale, timezone (IANA), tax name and default rate, tax registration label, distance unit and date format
2. Money stays as integers in the currency's minor unit throughout — the `_pence` column suffix from `data-model.md` is retained as the naming convention regardless of configured currency. `formatMoney` renders via `Intl.NumberFormat` using the configured currency and locale.
3. Timestamps display in the configured timezone, not a hardcoded `Europe/London`
4. Defaults are GBP, `en-GB`, `Europe/London`, VAT at 20%, miles
5. Document types are seeded from a UK template — DVLA licence, PHV driver badge, PHV vehicle licence, MOT, insurance, V5 — and a non-UK install can extend the set through its own migration
6. Tests cover at least one non-GBP, non-London configuration to prove nothing is hardcoded

---

## Definition of done

- All acceptance criteria pass
- A second install can be stood up from scratch with a different name, logo and colour scheme, and nothing in the UI or PDFs refers to the first
- CI grep for the original company name passes clean
- CSV import round-trips: export drivers, re-import, no duplicates created
