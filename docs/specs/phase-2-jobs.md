# Phase 2 — Jobs

**Goal:** the operational core — job creation with price captured at booking, a list that scales, status transitions backed by an event log, and the finance panel.

**Depends on:** Phase 1.

**The point of this phase:** the legacy system's central failure is that pricing is an optional afterthought, so 140 of 141 jobs are worth £0. Everything here is designed to make an unpriced job visible and awkward rather than invisible and normal.

---

## 2.1 Job creation

**Acceptance criteria**
1. Form fields: client (searchable, with inline "create new"), account, job type, date, time, pickup, dropoff, via, driver, vehicle, passenger name/phone/count, luggage, flight number, notes, internal notes, **client price**, **driver price**
2. **Client Price and Driver Price appear on the create form**, not behind a modal — this is the single most important requirement in the phase
3. Date and time entered in London local time, stored as UTC `scheduledAt`
4. Selecting a driver defaults the vehicle to their assigned one; the vehicle remains changeable
5. Flight number field appears only for `AIRPORT_TRANSFER`
6. Pickup and dropoff autocomplete from saved `Location` records while still accepting free text
7. Selecting a driver or vehicle that fails `isCompliantAt(scheduledAt)` blocks submission with the specific reasons listed
8. Selecting a driver already committed within a configurable buffer of `scheduledAt` shows a conflict warning naming the clashing job — warns, does not block
9. Submitting without a client price shows a confirm step: "This job has no price. Jobs without prices don't appear in revenue reports." Continue or go back.
10. On save, `reference` is allocated as `WLX-` plus a zero-padded sequence, and a `CREATED` job event is written
11. Selecting a client and account pre-fills a suggested price from the rate card when one matches (Phase 4 wires the resolution; here it is a stub returning null)

## 2.2 Job list

**Acceptance criteria**
1. **Server-side pagination**, default 50 per page, maximum 100 — the page never loads all jobs
2. Filters: date range, status, job type, driver, client, account, vehicle, and an **unpriced** toggle
3. Search across reference, client name, driver name, account name, pickup and dropoff
4. Sortable by scheduled time, reference, client, driver and gross profit
5. Columns: reference, date/time (London), type, pickup, dropoff, client, account, driver, vehicle, status, client price, gross profit, margin %
6. **Unpriced jobs show a red "No price" badge in place of the price**
7. Row actions: view, edit, finances, duplicate, cancel, delete (`ADMIN`)
8. Filter state persists in the URL so views are shareable
9. Default view is today and the next 7 days, not all history
10. A count header reads "N jobs · M unpriced" for the current filter
11. Loads in under 500 ms at 10,000 jobs — test with seeded volume

## 2.3 Job detail

**Acceptance criteria**
1. Full record with inline edit for users holding the right role
2. Status control offering only legal next transitions
3. Timeline panel rendering `JobEvent` history with durations between events
4. Finance summary with a link to the finance panel
5. Linked invoice shown when one exists
6. Expenses list with receipt thumbnails
7. Audit trail visible to `ADMIN`
8. "Duplicate job" pre-fills a new job from this one, with the date cleared
9. "Create return journey" pre-fills a new job with pickup and dropoff swapped

## 2.4 Status transitions

**Acceptance criteria**
1. Transitions enforced server-side per the state machine in `data-model.md`; illegal transitions return `409 INVALID_TRANSITION`
2. Every transition writes a `JobEvent` with actor, type and timestamp
3. `jobs.status` is updated in the same transaction as the event insert
4. `ASSIGNED` requires both driver and vehicle, both compliant at `scheduledAt`
5. **`COMPLETED` requires `clientPricePence > 0` or a non-empty `zeroValueReason`** — otherwise `409 PRICE_REQUIRED`
6. The zero-value reason prompt offers preset options (goodwill, cancelled in transit, internal transfer, duplicate) plus free text
7. Cancelling a job on a `SENT` or `PAID` invoice is refused with a message directing the user to raise a credit note
8. Bulk status change from the list view, with the same validation applied per job and a per-job result summary

## 2.5 Finance panel

Ports the legacy finance modal, with the arithmetic moved server-side.

**Acceptance criteria**
1. Revenue inputs: base fare, wait time, extra charges + notes, customer hours, customer rate
2. Cost inputs: driver payment, fuel, other expenses + notes, driver hours, driver rate
3. Totals and gross profit are read-only, calculated live in the UI for feedback and **recalculated server-side on save**
4. Driver settlement: pay status, method, paid date, notes
5. Opening the panel on a job with a booking price but no finance record pre-fills base fare from `clientPricePence` and driver payment from `driverPricePence`
6. Margin % displayed alongside gross profit, in red when negative
7. Saving writes an audit entry with before and after
8. `ACCOUNTS` and `ADMIN` may edit; `OPS` read-only
9. Wait time is read-only and auto-calculated once Phase 5 supplies `ARRIVED` and `POB` events; until then it is manually editable

## 2.6 Unpriced job surfacing

**Acceptance criteria**
1. Dashboard tile: "N completed jobs without a price", linking to the filtered list
2. The tile turns red above a configurable threshold, defaulting to 5
3. `/api/cron/unpriced-digest` emails ops a daily list of completed unpriced jobs
4. Reports show `unpricedJobCount` alongside every revenue figure
5. Bulk price entry: select rows in the list and set client and driver price for all of them, for backfilling migrated data

## 2.7 Finding a driver in a long list

Added after the first customer, at 195 owner-drivers, described the driver and
vehicle pickers as "very long to go through". They were: one option per driver,
in a native select that opens as a scroll of two hundred names.

**Acceptance criteria**
1. A search box above the driver and vehicle selects narrows the options to
   what has been typed, matching anywhere in the label so a name or a reference
   works equally
2. Matching ignores case, spacing and punctuation — "O'Brien" typed without the
   apostrophe is the same person
3. Order is preserved rather than re-ranked. The list is already sorted by name
   and by registration, and re-ordering it moves things around under somebody
   who knows where they are
4. **The current selection always survives the filter.** A native `<select>`
   whose selected `<option>` leaves the DOM loses its value silently, so a
   dispatcher who picks a driver and then types would book a job with nobody on
   it and see nothing wrong. This is the rule the feature lives or dies by
5. The search box is not part of the form. It has no `name`, nothing about it
   is submitted, and Enter inside it filters rather than booking the job
6. A filtered list says how much it is hiding — "Showing 3 of 195" — because a
   select holding three of a hundred and ninety-five options otherwise looks
   like a system that has lost the rest
7. Short lists get no search box. A four-vehicle install does not need one, and
   it is one more thing on the screen with nothing to find
8. The native select is kept rather than replaced by a custom combobox. It
   carries the keyboard behaviour, the mobile picker and the form-post contract
   for free, and it is genuinely faster on a laptop, which is where dispatch
   works

---

## Definition of done

- All acceptance criteria pass
- Seeded with 10,000 synthetic jobs; list, filter and sort all respond in under 500 ms
- E2E: create a job with prices → assign → complete → verify the timeline and totals
- E2E: attempt to complete an unpriced job → blocked → supply a reason → succeeds
- E2E: attempt to assign a driver with an expired PHV badge → blocked with the reason shown
