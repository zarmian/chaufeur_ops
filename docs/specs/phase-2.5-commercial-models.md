# Phase 2.5 — Commercial models

**Goal:** the operator does not run one business, it runs three. Chauffeur
work with an owner-driver, chauffeur work with a hired driver in the
company's own car, and renting the company's cars out. Phase 2 modelled only
the first.

**Depends on:** Phase 2.

**The point of this phase:** every number in Phase 2 assumes a per-job driver
fee and an owner-driver who bears their own running costs. Under the other two
models that assumption produces wrong gross profit — sometimes flatteringly
wrong, which is worse. A hired driver is paid for a shift that may span
several jobs or none; a rented-out car earns money with no job attached at
all.

---

## 2.5.1 Engagement

How a driver is working *at a given moment*. Not a fixed property of the
person: the same driver can be an owner-driver one week and hired the next,
and can rent a car regardless.

**Acceptance criteria**

1. `DriverEngagement` records a driver, a kind (`OWNER_DRIVER`, `HIRED`), an
   effective-from date and an optional effective-to date
2. `HIRED` engagements carry the hourly rate, and optionally a day rate and
   an overtime threshold
3. Engagements for the same driver may not overlap in time; the API refuses
   an overlapping period and names the one it clashes with
4. A job may override the engagement for that job alone, for the case where
   someone covers a single run on different terms
5. Resolution order is: the job's own override, then the engagement whose
   period contains the job's `scheduledAt`, then `OWNER_DRIVER` as the
   default — a driver with no engagement record behaves exactly as in Phase 2
6. Resolution is by the job's **scheduled time**, never by "now", so
   re-opening a historic job shows the terms it was actually worked under
7. The driver detail page shows the engagement history, most recent first

## 2.5.2 Shifts

**Acceptance criteria**

1. `DriverShift` records driver, optional vehicle, start, end, unpaid break
   minutes, and the hourly rate **snapshotted at the time it was opened**
2. The snapshot is the point: a rate rise must not silently re-price shifts
   worked last month
3. Paid minutes are `(end − start) − break`, never negative
4. Shift pay is `paid hours × rate`, rounded to the penny once
5. A shift with no end is open; a driver may have only one open shift at a
   time, and starting a second is refused naming the open one
6. Jobs may be attributed to a shift. A job attributed to a shift shows
   "driver paid by shift" instead of a per-job driver cost, and contributes
   no driver payment to its own gross profit
7. Shift profitability is revenue of the jobs in the shift, minus shift pay,
   minus company-borne expenses on those jobs
8. A shift may be approved; approving locks the times against further edits
   by anyone below `ADMIN`
9. Payouts include shift lines as well as job lines

## 2.5.3 Vehicle rental

Renting the company's cars to drivers, per hour, per day or per week. Full
management: deposits, mileage, fuel, condition and a handover checklist.

**Acceptance criteria**

1. `VehicleRental` records vehicle, renter, planned start and end, actual
   return, rate type (`HOURLY`, `DAILY`, `WEEKLY`), rate, and status
   (`BOOKED`, `ACTIVE`, `RETURNED`, `CANCELLED`)
2. References are allocated from the configured prefix, like jobs
3. Charge is whole rate periods, rounding **up** — an extra hour on a daily
   hire is a second day, which is what a rental agreement says
4. Where the actual return is later than planned, the charge follows the
   actual return
5. Deposit taken and deposit returned are tracked separately, with the date
6. Mileage out and in, and fuel level out and in, are recorded at handover
7. A handover checklist is recorded at collection and again at return, item
   by item, with a note against any item not in order
8. Damage found at return can carry a charge, which is added to the balance
   and is not part of the rental rate
9. Balance owed is charge plus damage minus payments received; arrears are
   visible in a list and on the vehicle
10. **A vehicle out on rent cannot be assigned to a job** for the period of
    the rental, refused the same way lapsed documents are refused
11. Rental revenue appears in reports alongside job revenue, and is never
    silently folded into it

## 2.5.4 Stops

**Acceptance criteria**

1. A job may have any number of ordered stops between pickup and dropoff
2. Each stop records an address, and optionally arrival and departure times,
   waiting minutes and a charge
3. Stop charges are revenue and roll into the job total
4. The existing free-text `via` remains for jobs that do not need structure

## 2.5.5 Itemised expenses

`JobExpense` already exists in the schema with the right kinds. It has never
had a user interface, and nothing it holds reaches a total.

**Acceptance criteria**

1. Expenses can be added to a job with kind, amount, note and a receipt
2. Each expense records who bears it: the client (recharged), the company, or
   the driver
3. The default bearer follows the engagement — under `HIRED` the company
   bears fuel; under `OWNER_DRIVER` the driver does — and is always editable
4. Recharged expenses increase the client total; company-borne expenses
   increase cost; driver-borne expenses do neither
5. The finance panel shows the itemised expenses feeding its totals rather
   than a single unexplained figure

## 2.5.6 Hourly pricing on the booking form

**Acceptance criteria**

1. `AS_DIRECTED` jobs ask for hours and an hourly rate **on the booking
   form**, not only in the finance panel
2. A minimum-hours rule applies: billed hours are the greater of hours booked
   and the configured minimum
3. The form shows the resulting total as it is typed
4. Wait time and stop charges are additional to the hourly charge, never
   folded into it

---

## Definition of done

- All acceptance criteria pass
- E2E: hire a driver for a shift covering two jobs → both jobs show "paid by
  shift" → the shift shows pay and profitability
- E2E: rent a car out → the car is refused for a job in that period → return
  it with damage → the balance owed reflects it
- E2E: an as-directed job priced by the hour, with a stop charge and a
  recharged congestion charge, totals correctly
