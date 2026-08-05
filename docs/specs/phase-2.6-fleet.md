# Phase 2.6 — Fleet

**Goal:** know what each car is actually making.

**Depends on:** Phase 2.5.

**The point of this phase:** not every car on the system belongs to the
company. Most are owner-drivers'. The company's own cars are on finance or
lease, which means a standing monthly cost the car has to earn back before it
makes anything — and repairs, servicing, insurance and tax on top. None of
that was recorded anywhere, so "is this car worth keeping" had no answer.

A driver-owned car costs the company nothing to run. Its repairs are its
owner's problem, and counting them would be wrong. But it still earns: the
jobs it does bring in revenue and the driver is paid out of it. So both kinds
appear in the profit view, measuring different things — a company car's
profit after running it, and a driver-owned car's margin.

---

## 2.6.1 Ownership

**Acceptance criteria**

1. Every vehicle records how it is held: `OWNED`, `FINANCED`, `LEASED` or
   `DRIVER_OWNED`
2. `DRIVER_OWNED` is the default, so the existing fleet keeps behaving exactly
   as it did — this phase is additive
3. A driver-owned car records whose it is
4. A company car records when it was acquired, what it cost, and when it was
   disposed of if it has been
5. The vehicle list can be filtered by ownership, and shows it

## 2.6.2 Running costs

**Acceptance criteria**

1. One-off costs are recorded against a vehicle with kind, amount, date,
   supplier, an invoice reference, the odometer reading and an optional
   receipt

   > The receipt is the one part not built. `VehicleCost.receiptFileKey`
   > exists and the storage layer is there, but the upload path is not wired
   > up — a receipt currently goes on the vehicle's documents panel, not
   > against the individual cost. Finish it when Phase 4 needs receipts for
   > VAT reclaim, which is the first point at which cost-level attachment
   > actually matters.
2. Kinds cover servicing, repairs, MOT, tyres, bodywork, cleaning, breakdown
   cover and anything else
3. Standing costs — insurance, road tax, finance and lease payments — are
   recorded once with an amount, a period and a start date, and **accrue
   pro-rata across any window asked about**
4. A £1,200 annual insurance premium therefore shows as £100 in a month, not
   £1,200 in April and nothing after. A car must not look unprofitable in the
   month its insurance falls due
5. Both kinds appear together on the vehicle, newest first
6. **Costs cannot be recorded against a driver-owned car.** They are its
   owner's, and recording them here would understate that car's margin and
   overstate the company's expenditure

## 2.6.3 Servicing

**Acceptance criteria**

1. A vehicle records its current odometer reading, when it was last serviced
   and at what mileage
2. A service is due at a configurable interval — by date, by mileage, or
   whichever comes first
3. A service becoming due is surfaced the way a lapsing document is, in the
   same list, because both stop the car earning
4. Recording a service cost updates the last-service date and mileage
5. **A service falling due does not block assignment.** A lapsed MOT is
   illegal; an overdue service is a maintenance decision the operator makes

## 2.6.4 Profit per vehicle

**Acceptance criteria**

1. For a window of dates, a vehicle shows:
   - revenue from jobs it was on
   - revenue from rentals of it
   - driver pay attributable to those jobs and any shifts on it
   - company-borne expenses on those jobs
   - its own running costs, one-off and accrued standing
   - the resulting profit and margin
2. Rental revenue is shown as its own line, never folded into job revenue
3. A driver-owned car shows revenue, driver pay and the resulting margin, and
   **no running costs at all**
4. The window defaults to the last twelve months and is changeable
5. A fleet view ranks vehicles by profit, so the worst performer is visible
   without opening every car
6. A car with no activity in the window says so, rather than showing zeroes
   that read like a loss-making car

---

## Definition of done

- All acceptance criteria pass
- E2E: record a repair and an annual insurance premium against a company car →
  the month's profit reflects one twelfth of the premium, not all of it
- E2E: a driver-owned car shows its margin and refuses a cost entry
