# Phase 4 — Money

**Goal:** stop typing prices twice. Rate cards, invoicing with VAT, an invoice ledger, driver payouts and reports that reconcile.

**Depends on:** Phase 3 — imported drivers, vehicles and clients make rate card rules testable against real routes.

**Before starting:** get the real commercial rates from the business. Zones, fares and driver splits are commercial decisions, not engineering ones.

---

## Already in place

Two things Phase 4 needs were built ahead of it, because the shape of the
data had to be right before the screens could be written at all.

**A payout can hold a shift.** `DriverPayoutLine.jobId` was `NOT NULL`, so a
driver paid by the hour to drive one of the company's own cars had no way onto
a payout — there is no per-job fee to pay them. The line now carries either a
job or a shift, with a database check that it is exactly one. `lib/payout-lines.ts`
builds the draft and holds the rule that stops anyone being paid twice: a job
attached to a shift never produces a line of its own, or an eight-hour shift
with six runs in it would pay for the shift *and* six fees.

**A rental can be invoiced.** Rental income reached the per-vehicle profit
view and nowhere else, so a hire could not be billed except as untraceable
free text. `InvoiceLine` now carries an optional `rentalId`, and
`lib/billable.ts` gathers jobs and rentals into one list — a hire billed for
what is still owed after cash already taken, never for its full charge twice.

`lib/revenue.ts` answers the reporting question separately, and deliberately:
a report counts what was *earned* whether or not anyone billed for it, so a
hire settled in cash still counts there and does not appear as billable.

What remains for this phase is the screens, the numbering sequence, the PDFs
and the ledger.

---

## 4.1 Zones and locations

**Acceptance criteria**
1. Zone CRUD: name plus a list of postcode prefixes
2. Seeded with Heathrow, Gatwick, Luton, Stansted, London City, Central London, Greater London, Outside M25
3. `resolveZone(text, postcode?)` matches free text and postcodes to a zone, tested against real pickup strings from the migrated data
4. Airport terminal strings ("London Heathrow airport terminal 5", "LHR T5", "Heathrow T5") all resolve to Heathrow
5. Location CRUD with autocomplete ordered by `useCount`
6. `useCount` increments when a location is chosen on a job
7. Unmatched pickup text is logged so the zone matcher can be improved

## 4.2 Rate cards

**Acceptance criteria**
1. Rate card CRUD with name, active date range, default flag
2. Rule CRUD: job type, vehicle class (nullable = any), from zone, to zone, base fare, per hour, minimum hours, free wait minutes, wait per minute, driver base, driver per hour, driver % of fare, priority
3. `resolveRate(job)` in `lib/pricing/` returns the best-matching rule, or null
4. Matching is most-specific-first: exact zone pair beats one-sided beats any-zone; higher `priority` breaks ties
5. Driver pay resolves from a fixed rate **or** a percentage of fare, never both — validation rejects a rule setting both
6. `POST /api/jobs/:id/price-from-rate-card` returns `{ clientPricePence, driverPricePence, ruleId, explanation }` without saving
7. The job form calls it when client, account, type, zones and vehicle class are all known, pre-filling both price fields with a visible "from rate card" marker and full manual override
8. Overriding a rate-card price records the original and the override in the audit entry
9. Accounts may carry their own rate card, overriding the default
10. A rate card in use cannot be deleted, only end-dated

## 4.3 Invoicing

**Acceptance criteria**
1. Create from selected jobs, filtered by client or account and date range, showing each job's value
2. Recipient may be the client or the account — chosen explicitly, defaulting to the account when the job has one
3. Invoice number allocated from a gapless yearly sequence: `INV-2026-0001`
4. Net computed server-side from the selected jobs; VAT at the configured rate; gross = net + VAT
5. A job already on a non-cancelled invoice cannot be added again — rejected with a message naming the existing invoice
6. Due date defaults to the recipient's payment terms
7. Line items are editable in `DRAFT`: description, amount, order, plus ad-hoc lines not tied to a job
8. PDF renders with the WeLux letterhead, VAT number, bank details, per-job line detail, net/VAT/gross breakdown and payment terms
9. "Send" renders the PDF, emails it to the billing address and sets `SENT` with a timestamp
10. A `SENT` or `PAID` invoice is immutable — edits return `409 INVOICE_LOCKED` and the UI offers a credit note instead
11. Credit notes are negative invoices referencing the original
12. Payments recorded against an invoice; `paidPence` accumulates and status moves to `PART_PAID` or `PAID` automatically
13. Status becomes `OVERDUE` automatically once past the due date and unpaid

## 4.4 Invoice ledger

The legacy system generated invoices and then lost track of them. This is the fix.

**Acceptance criteria**
1. List with filters: status, client, account, date range, overdue only
2. Columns: number, date, due date, recipient, net, VAT, gross, paid, outstanding, status
3. Header totals for the current filter: total invoiced, total paid, total outstanding
4. Aging report bucketing outstanding balances into 0–30 / 31–60 / 61–90 / 90+ by client
5. Excel export of both the ledger and the aging report
6. Overdue rows visually distinct, sorted by days overdue

## 4.5 Driver payouts

**Acceptance criteria**
1. Generate drafts for a period, for all drivers with completed unpaid jobs, or a chosen subset
2. Payout lines drawn from `driverPaymentPence` on each job's finance record
3. Approved-plus-marked-paid sets `driverPayStatus = FULLY_PAID` on every included job, in one transaction
4. A job may appear on only one non-cancelled payout
5. PDF statement per driver: period, job list with dates, routes and amounts, total, payment reference
6. List filterable by driver, period and status
7. Payout summary tile: total owed to drivers this period
8. Expenses marked as driver-recoverable are included as separate lines

## 4.6 Reports

**Acceptance criteria**
1. Filters: date range, driver, client, account, vehicle, job type, status
2. Summary tiles: jobs, revenue, costs, gross profit, margin %, **and unpriced job count**
3. Unpriced count is displayed with equal prominence to revenue — a revenue figure without it is misleading
4. Breakdowns by job type, client, account, driver and vehicle, each with revenue, cost, profit and margin
5. Month-on-month trend chart for revenue and profit
6. Detail table with server-side pagination
7. Export to Excel and PDF, with the filter criteria printed in the header
8. Aggregations run in SQL, not in application memory
9. Report totals reconcile exactly with the sum of the underlying job finance records — an automated test asserts this

## 4.7 Payment gateways

**Acceptance criteria**
1. Revolut Business and SumUp credentials configurable in Settings, with sandbox and production environments
2. A "Test connection" control verifies credentials before saving
3. Payment links can be generated on an invoice and included in the emailed PDF
4. Webhook endpoints record incoming payments against the right invoice
5. Webhook signatures verified; unverified requests rejected before parsing
6. The payments list shows gateway transactions with their linked invoice
7. Gateways remain fully optional — manual payment recording works without either being enabled

---

## Definition of done

- All acceptance criteria pass
- Rate card seeded with the business's real rates, and `resolveRate` tested against at least 50 migrated jobs
- Automated test proves report totals equal the sum of job finances
- E2E: price a job from the rate card → complete → invoice → record payment → confirm it appears in the ledger and aging report
- E2E: generate a payout → approve → mark paid → confirm every job flips to `FULLY_PAID`
