# Phase 6.5 — Flight tracking

Airport work is most of what this fleet does, and a flight landing ninety
minutes late costs the same money twice. The driver sits in a car park on a
wait-time clock the client argues about afterwards, and the car is not where it
was supposed to be next. Today the only warning is a passenger texting the
office, or nothing at all.

The whole feature is one question — **when will this aeroplane actually land,
and does the car need to move?** — and one rule about the answer: the buffer
between the landing and the pickup belongs to whoever booked it.

## 6.5.1 The provider is configuration, not a dependency

Providers differ wildly on price, on how far ahead they will give a schedule,
and on whether they report a revised arrival time at all — and one that says
"Delayed" without saying by how much cannot move a pickup. The one an install
starts on is unlikely to be the one it stays on.

**Acceptance criteria**
1. `lib/flights/types.ts` defines what every adapter implements: a flight number and a date in, a state and three timestamps out
2. Adding a provider is one file and one entry in the registry; nothing that decides anything imports an adapter
3. Provider statuses are mapped down to six states in the adapter, and anything unrecognised becomes `UNKNOWN` rather than falling through to "running normally"
4. The key is stored per install, encrypted, and never returned to a browser
5. Tracking is off until somebody switches it on *and* supplies a key. With it off, every airport job behaves exactly as it did before this existed
6. `AeroDataBox` is the first adapter. **It has not been run against the live API** — the mapping is unit-tested against fixtures built from the published documentation, and one real call is required before an install is switched on

## 6.5.2 The buffer is the operator's

A booking made for 40 minutes after a scheduled landing is a person's judgement
about that airport, that terminal and that client — long enough for bags off a
wide-body, short enough that the car is not paid to sit there.

**Acceptance criteria**
1. The gap between the *scheduled* arrival and the pickup somebody typed is measured, and preserved against the new arrival. A flight 90 minutes late moves the pickup 90 minutes; it is never recomputed from a rule of ours
2. The gap is measured from where a **person** last put the pickup, never from a time tracking itself set — otherwise each adjustment folds into the next and the car walks steadily away from the aeroplane
3. An actual landing time beats an estimate, which beats the timetable
4. A movement smaller than the configured threshold (default 15 minutes) is ignored: nobody re-plans a morning for six minutes
5. With no scheduled arrival there is no buffer to preserve, so it flags rather than guesses — that case is almost always a mistyped flight number

## 6.5.3 What it will and will not do by itself

**Acceptance criteria**
1. `autoAdjust` is **off by default**. With it off the flight is still checked, the delay is still known and the office is still told; only the rewriting of somebody's booking waits for a person
2. A cancellation is never applied automatically. It is not a delay, and moving the pickup would hide it
3. A diversion is never applied automatically. The time is not the problem; the airport is
4. A later pickup is always safe to apply — nobody misses a car by being told it is later
5. An **earlier** pickup is only applied with enough notice (default 90 minutes). Inside that window it is flagged instead: a driver may already be on the road, and a person can ring them where a cron cannot
6. When a pickup does move it goes through the same path a human edit takes, so the driver gets the change message and their job card is refreshed. A pickup that moved in the database and not on the driver's phone is worse than one that did not move
7. The change is written to `audit_log` with a **null user**, because no member of staff did it

## 6.5.4 Asking, and not asking

Every lookup is billed.

**Acceptance criteria**
1. One lookup per flight per date, however many cars are meeting it — a family in two cars, two clients off the same New York service
2. Flight numbers are normalised before anything else: `BA 0117`, `ba117` and `BA117` are one aeroplane and one cache entry
3. A flight is not asked about again inside the refresh interval (default 20 minutes)
4. In the hour around landing it is asked about more often, because that is where an estimate moves twenty minutes between looks and where a stale answer is the expensive one
5. A lookup that found nothing is recorded, so a mistyped number is not asked about — and billed for — on every run for as long as the job exists
6. A provider outage leaves the last known answer standing. A delay found an hour ago is truer than pretending the flight is on time
7. Nothing in the run throws. One unreachable provider must not take down the pass and skip every other flight in it

## 6.5.5 Where it shows

**Acceptance criteria**
1. The job screen shows what tracking last heard beside the flight number, and nothing at all when no provider is configured
2. A pickup that tracking moved says so, with the time a person had originally set
3. Every flag reaches the office through the existing ops alert, saying plainly whether anything was changed
4. `/api/cron/flights` returns a summary — checked, looked up, shifted, flagged, errors — rather than only logging. A cron whose only evidence of working is the absence of an error is one nobody notices has stopped

---

## Definition of done

- All acceptance criteria pass
- **One real call against the configured provider**, with the response compared against `lib/flights/aerodatabox.test.ts`'s fixtures, before any customer is switched on
- A week run with `autoAdjust` off, watching the flags, before it is turned on
- The Vercel plan checked: the schedule is every fifteen minutes, which Hobby does not allow (see `docs/deployment.md`)
