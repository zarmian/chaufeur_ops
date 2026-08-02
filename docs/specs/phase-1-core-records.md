# Phase 1 — Core Records

**Goal:** clients, accounts, drivers, vehicles and compliance documents, with the expiry tracking the legacy system never had.

**Depends on:** Phase 0.

**Why before jobs:** a job references all of these. Building jobs first means free-text fields you then have to migrate away from — which is precisely how the legacy system arrived at its problems.

---

## 1.1 Clients

**Acceptance criteria**
1. List with server-side pagination, search by name, phone or email, and an archived filter
2. Create and edit: name, contact phone, contact email, billing email, billing address, VAT number, payment terms (default 14 days), default account, notes
3. `normalisedName` is computed on save — lowercase, punctuation stripped, whitespace collapsed, honorifics removed
4. Creating a client whose `normalisedName` already exists shows a "possible duplicate" warning with a link to the existing record, but does not block
5. Client detail page shows job history, lifetime revenue and outstanding invoice balance
6. Archive (soft delete) is blocked while non-cancelled jobs or unpaid invoices exist
7. `OPS` and `ADMIN` can edit; `ACCOUNTS` can edit billing fields only; `VIEWER` read-only

## 1.2 Accounts (bookers)

**Acceptance criteria**
1. CRUD with name (unique), kind (`INTERNAL` / `AGENCY` / `CORPORATE` / `INDIVIDUAL`), contact details, billing details, VAT number, payment terms, assigned rate card, commission %
2. List shows job count and revenue for the current month
3. Detail page shows jobs, invoices and margin for the account
4. An account cannot be archived while it has unpaid invoices

## 1.3 Vehicles

**Acceptance criteria**
1. CRUD: registration (unique, normalised uppercase with spaces stripped for comparison, original preserved for display), make, model, variant, class, colour, seats
2. Compliance fields: PHV licence number and expiry, MOT expiry, insurance policy number and expiry
3. Status: `ACTIVE` / `OFF_ROAD` / `RETIRED`
4. List shows a compliance indicator per vehicle — green, amber (≤30 days), red (≤7 days), black (expired) — reflecting the earliest expiry across all its documents
5. Filterable by status, class and compliance state
6. Detail page shows the assigned driver, document list and job history
7. Duplicate registration is rejected with a clear message naming the existing vehicle

## 1.4 Drivers

**Acceptance criteria**
1. CRUD: name, phone, email, address, DVLA licence number and expiry, PHV badge number, expiry and issuing authority, assigned vehicle, status, notes
2. `reference` auto-generated as `DRV-0001` upward, immutable once set
3. Same four-state compliance indicator as vehicles, spanning both the driver's own documents and those of the assigned vehicle
4. List filterable by status and compliance state, searchable by name, phone or reference
5. Detail page shows documents, assigned vehicle, upcoming jobs, and earnings for a chosen period
6. Assigning a vehicle already assigned to another active driver warns but does not block — relief drivers are legitimate
7. Setting a driver `INACTIVE` or `SUSPENDED` warns if they hold future assigned jobs and lists them

## 1.5 Document management

**Acceptance criteria**
1. Upload against a driver or vehicle with type, issue date and expiry date
2. Accepts jpeg, png, webp, pdf up to 10 MB; anything else is rejected with a clear message
3. Files go to R2; only the key is stored in Postgres
4. Viewing generates a 15-minute signed URL — files are never publicly readable
5. Uploading a new document of a type that already exists offers "replace" (sets `supersededBy` on the old one, retains it) or "keep both"
6. Expiry date is required for `DVLA_LICENCE`, `PHV_BADGE`, `PHV_VEHICLE`, `INSURANCE` and `MOT`; optional for `V5_LOGBOOK` and `OTHER`
7. Deleting a document is soft and `ADMIN`-only
8. A document with no expiry on a type that requires one appears in the compliance report as "unknown expiry" — never as compliant

## 1.6 Compliance dashboard

The feature the legacy system lacked entirely, and the reason this phase sits early.

**Acceptance criteria**
1. Dashboard tile: counts of expired, critical (≤7 days) and warning (≤30 days) across drivers and vehicles
2. Clicking through opens a filterable list showing entity, document type, expiry date and days remaining
3. Sorted most urgent first, expired at the top
4. Rows with unknown expiry are listed separately under "expiry not recorded" with their own count
5. Export to Excel
6. `GET /api/compliance/expiring?days=N` returns the structure in `api-spec.md`
7. Threshold days configurable in Settings, defaulting to 30 and 7

## 1.7 Compliance enforcement

**Acceptance criteria**
1. `isCompliantAt(driverId, datetime)` and `isCompliantAt(vehicleId, datetime)` in `lib/compliance.ts`, returning `{ compliant: boolean, reasons: string[] }`
2. A driver is non-compliant if their DVLA licence or PHV badge expires before the given datetime
3. A vehicle is non-compliant if its MOT, insurance or PHV vehicle licence expires before the given datetime
4. Unknown expiry counts as non-compliant, with a distinct reason string
5. Fully unit-tested, including boundary cases on the expiry date itself (expiry date is inclusive — valid through end of that day, London time)
6. Used by job assignment in Phase 2 — build it here, wire it there

---

## Definition of done

- All acceptance criteria pass
- Seed data covers at least 3 clients, 2 accounts, 5 drivers, 5 vehicles and a spread of document expiry states including expired and unknown
- E2E: create a driver, upload a PHV badge expiring in 5 days, confirm it appears in the critical bucket
- Compliance helper has full unit coverage — Phase 2 depends on it being right
