# Phase 4.8 — Bank reconciliation and address search

**Goal:** stop retyping what the bank already knows, and stop retyping
addresses the map already knows.

**Depends on:** Phase 4 — invoices, payouts and the payments list all exist,
and this is the thing that fills them in from the outside.

---

## Why these two together

They look unrelated and are, except in one respect: both replace typing with
matching, and both have to be honest about the cases they cannot match.

A reconciliation that quietly allocates a payment to the wrong invoice is
worse than one that allocates nothing — the money looks accounted for and
nobody looks again. An address search that silently picks the wrong Heathrow
terminal is worse than a free-text box, because the operator stops reading
what they typed. So the requirement common to both is that **the unmatched
case is visible, and the matched case is reversible.**

---

## 4.8.1 Statement import

A bank statement is a CSV, and every bank exports a different one.

**Acceptance criteria**

1. CSV upload accepting the common UK bank exports — the parser handles
   Barclays, HSBC, Lloyds, NatWest, Revolut Business and Starling column
   layouts without the operator mapping columns by hand
2. Unrecognised layouts fall back to a column-mapping step rather than
   failing: the operator says which column is the date, the amount and the
   description, and that mapping is remembered per bank
3. Amounts parse to integer pence. A statement with `1,234.56` and one with
   `1234.56` and one with separate debit and credit columns all produce the
   same figure
4. Dates parse day-first. `03/04/2026` is 3 April, because that is what a UK
   bank means by it
5. A transaction already imported is not imported twice — matched on the
   bank's own reference where there is one, and on a hash of date, amount and
   description where there is not
6. The import is previewed before anything is written: how many rows, how
   many already seen, how many the parser could not read

## 4.8.2 Classification

Not every line on a statement is an invoice payment.

**Acceptance criteria**

1. Each transaction is classified as one of: **client payment**, **driver
   payout**, **fuel**, **vehicle cost**, **rental income**, **transfer**, or
   **unclassified**
2. Classification uses the description against rules the operator can edit,
   plus the direction and the amount. A rule is a phrase and a
   classification, nothing cleverer
3. Rules are learnable: classifying a transaction by hand offers to create a
   rule from its description, and says how many past transactions the rule
   would also have caught
4. Anything unmatched stays **unclassified** and visible. It is never guessed
   into a category to make the list look finished
5. Seeded with the obvious UK ones — `SHELL`, `BP`, `ESSO`, `TFL`,
   `CONGESTION`, `DVLA` — as a starting point the operator edits

## 4.8.3 Allocation to invoices

The part the operator asked for, and the part most able to do damage.

**Acceptance criteria**

1. A credit matched to a client or account is allocated across that
   recipient's outstanding invoices **oldest first**, until the money runs
   out
2. The last invoice a payment partly covers becomes `PART_PAID` for the
   remainder; everything before it becomes `PAID`
3. Money left over after every outstanding invoice is settled is recorded as
   **unallocated credit** against the recipient, not forced onto an invoice
   and not silently dropped
4. Allocation is **proposed, not applied**. The screen shows exactly which
   invoices each credit would clear and what would be left part-paid, and
   nothing is written until somebody confirms
5. Confirming applies every allocation in one transaction, writing the same
   `Payment` rows a manual entry or a gateway webhook would
6. An allocation can be undone: the payments it created are reversed and the
   invoices return to the status and `paidPence` they had before
7. A transaction the system cannot attribute to a recipient is listed for
   manual allocation rather than being spread across whoever is oldest
8. Nothing is ever allocated to a `DRAFT` invoice — a draft has not been sent
   and nobody has been asked to pay it

## 4.8.4 The other side of the statement

Debits matter as much as credits.

**Acceptance criteria**

1. A debit classified as a driver payout can be matched against an approved,
   unpaid `DriverPayout` of the same amount, and marks it paid
2. A debit classified as fuel or a vehicle cost can be recorded against a
   vehicle as a `VehicleCost`, using the fleet code already built
3. Both are proposals, confirmed the same way as invoice allocations
4. Transfers between the operator's own accounts are classified and then
   ignored — they are not income and not cost, and counting them would
   double every figure on the reports

## 4.8.5 Reconciliation screens

**Acceptance criteria**

1. Import screen: upload, preview, and the count of rows in each state
2. Statement list, filterable by date range, classification and whether a row
   is allocated
3. Per-transaction detail showing what it was matched to and why
4. A running "unreconciled" total: money in the bank that no invoice, payout
   or cost accounts for. This is the number that tells an operator whether
   the books are straight
5. Excel export of the statement with its classifications and allocations

---

## 4.8.6 Address search

**Acceptance criteria**

1. Pickup and destination fields offer address suggestions as the operator
   types, replacing the plain datalist of saved locations
2. Suggestions come from a configured provider; **Google Places** is the
   first implementation because its coverage of named places — "The
   Dorchester", "Heathrow T5" — is what a chauffeur operator actually types
3. The provider is a seam. A second implementation can be added without
   touching the booking form, and the system works with none configured
4. With no provider configured, the field falls back to today's behaviour —
   free text plus saved locations — and additionally validates and completes
   UK postcodes through `postcodes.io`, which needs no key and no billing
5. Choosing a suggestion stores the formatted address, the postcode, and the
   latitude and longitude on the job
6. A chosen suggestion is saved as a `Location` if it is not already one, so
   the second booking to the same hotel needs no lookup at all
7. The postcode from a suggestion feeds zone resolution directly, so a
   correctly-picked address prices correctly
8. Autocomplete requests are debounced and session-tokened, because Google
   bills per session and a request per keystroke is a bill per keystroke
9. The provider key is stored encrypted like every other credential, and the
   lookup is proxied through this application — a key in the browser is a key
   anybody can spend

---

## Definition of done

- All acceptance criteria pass
- A statement of 200 rows imports, classifies and allocates in one pass, and
  the resulting invoice statuses reconcile with the payments created
- Undoing an allocation returns every affected invoice to its previous state,
  proved by a test that snapshots before and after
- E2E: import a statement → review the proposal → confirm → the invoices show
  paid and the payments list shows the entries
- E2E: type a pickup, choose a suggestion, and the job stores the postcode
  and prices from the zone that postcode belongs to
