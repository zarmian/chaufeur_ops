# Phase 6.6 — The passenger's tracking link

The most common call any chauffeur office takes is "where is my car", and it
is almost always asked by somebody with no way of finding out. Every piece of
the answer already exists in this system — the driver's position, the ETA
calculation, the car, the status the driver taps. None of it reaches the person
who wants it.

This is a link that does. One page, no login, held by whoever booked.

## 6.6.1 What a stranger holding the URL may see

The link is forwarded. That is not an edge case — a booker sends it to their
passenger, a PA pastes it into a calendar invite, somebody drops it in a group
chat. So the question is never "what do we know about this job" but "what is
safe in front of whoever ends up holding this".

**Acceptance criteria**
1. Prices are never shown — not the client's, not the driver's. A passenger who can see both can see the margin, and a forwarded link would hand a competitor the rate card
2. The driver's phone number is never shown. A link outliving the job would leave an owner-driver's mobile on the internet
3. No other job, and no staff notes
4. Shown: whether a car is coming, who is driving, what they are driving, where from and to, and when it was booked for
5. The decisions live in `lib/tracking.ts`, which is pure, so each is a test rather than a judgement made while writing a template
6. The rendered HTML is asserted against, not only the view model — the page is what actually reaches the passenger

## 6.6.2 What it says, and when

**Acceptance criteria**
1. Before a driver is assigned: "your car is booked", and no ETA
2. Assigned but not moving: the driver is named, and **still no ETA**. A driver who has not set off has a last known position that is their home or their previous job, and a number computed from it is one the passenger will hold the office to
3. On the way: an ETA, from the same `etaForJob` the office sees
4. Arrived: "your car is here", with the car to look for — colour first, because that is what somebody scanning a line of cars sees before they can read a numberplate
5. On board: the ETA stops. The estimate is to the *pickup*, which is now behind them
6. Cancelled: no driver, no car. A registration beside "cancelled" reads as though one is still coming
7. The stage comes from the driver's own events, not the job status — `IN_PROGRESS` covers setting off, arriving and driving, and a passenger cares about the difference
8. An ETA that cannot be computed honestly is said out loud rather than left blank

## 6.6.3 The link itself

**Acceptance criteria**
1. 24 random bytes, the same width as the name board's and the driver's linking token
2. A separate token from the name board's: the board is the driver's and the tracking link is the passenger's, and revoking one must not blank the other
3. Issued lazily and then stable — a passenger who saved it the night before still has a working page in the morning, and re-sending the confirmation does not invalidate what they hold
4. Reissuing takes the old link away, which is why the token is a column and not a signature
5. Answers from 24 hours before the pickup until 6 hours after. Generous either side: a flight can land four hours late, and checking the night before is exactly what the link is for
6. Every refusal — no such token, reissued, expired, job deleted — gives one identical 404. Distinguishing them tells somebody guessing that they found a real one
7. The ETA is computed only when the page will show one, because it can call a paid routing API and this page refreshes itself

## 6.6.4 Where it appears

**Acceptance criteria**
1. A panel on the job screen with the link to open or copy, stating plainly what the page does and does not carry
2. The page is branded — a passenger who opens an unbranded page assumes they have been phished
3. It refreshes itself while the journey is live, and only while the tab is visible, so a link left open overnight does not poll until the battery goes
4. A dead link gets a passenger's not-found — the office's phone number, not "back to dashboard", which invites somebody with no account into an admin application

---

## Definition of done

- All acceptance criteria pass
- The page opened in a phone-sized browser from a context with no cookies, confirming it answers with no session and raises no CSP violation
- The rendered HTML checked for the price, the driver's phone number and the margin
- One link sent to a real client before it is offered as a feature
