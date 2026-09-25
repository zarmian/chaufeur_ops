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
0. **Revised.** The driver's Telegram handle is never shown either, for the
   same reason as the phone number. Where the passenger can message the
   driver, it is relayed through the bot: neither side ever learns the other's
   number or handle
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
5. **Revised.** Answers from the moment it is issued until the journey is
   over. There is no opening time — a link sent at booking has to work, or the
   client who taps it and gets a 404 does not tap the next one. What is held
   back is the *crew*: the driver and the car appear two hours before the
   pickup and not before, because a crew can still change and the fewer hours
   an owner-driver's name sits in a forwarded group chat the better
5a. The driver tapping Completed is what closes it, which is more precise than
   a clock and kinder: a journey running three hours late keeps working the
   whole time. A cancellation is the deliberate exception — "no car is coming"
   is the most valuable thing the page ever says, and the cancelled view names
   no driver and no car
5b. A backstop closes it 12 hours after the pickup regardless, because a driver
   who forgets to tap Completed must not leave a page naming somebody's driver
   live for ever
6. Every refusal — no such token, reissued, expired, job deleted — gives one identical 404. Distinguishing them tells somebody guessing that they found a real one
7. The ETA is computed only when the page will show one, because it can call a paid routing API and this page refreshes itself

## 6.6.4 Where it appears

**Acceptance criteria**
1. A panel on the job screen with the link to open or copy, stating plainly what the page does and does not carry
2. The page is branded — a passenger who opens an unbranded page assumes they have been phished
3. It refreshes itself while the journey is live, and only while the tab is visible, so a link left open overnight does not poll until the battery goes
4. A dead link gets a passenger's not-found — the office's phone number, not "back to dashboard", which invites somebody with no account into an admin application

## 6.6.5 Messaging the driver

Added after the first customer asked for it. The office's second most common
call, after "where is my car", is a passenger who cannot find the car that has
arrived — and the person who could resolve it in one line is sitting fifty
metres away with no way of being reached.

**Acceptance criteria**
1. Relayed through the bot, never connected directly. The passenger types on
   the page and the driver gets a bot message; the driver replies in Telegram
   and it appears on the page. Neither learns the other's number or handle —
   the same rule that withholds the driver's phone number, and the only
   arrangement that works at all, since drivers link by chat id and most have
   no public username
2. Open only when there is somebody to reach: a driver assigned, with Telegram
   linked, inside the two-hour window, on a journey that is not over. A box
   that reaches nobody is worse than no box — a passenger who types into one
   believes they have told somebody, and stops trying
3. Every closed state says why, in the passenger's terms. A driver who never
   linked Telegram is said out loud, with the office as the next step
4. A message recorded but not delivered is shown as exactly that. The
   difference between "they have not replied" and "they never heard you" is
   the difference between waiting and ringing
5. Rate limited per journey rather than per IP: the abuse worth stopping is one
   driver being buried under a forwarded link, and twenty phones in a group
   chat share a journey but not an address
6. A driver taken off the job cannot keep talking to a passenger who is now
   somebody else's
7. The thread closes with the link, and is still readable while the page is —
   somebody who asked a question on the way should not lose the answer

## 6.6.6 Sending it

**Acceptance criteria**
1. An opt-in client message, off by default like every other, sent two hours
   before the pickup — which is when the page has something to show and when
   the message box opens
2. Idempotent. The cron runs every few minutes and must never text the same
   client twice; the send is claimed on the job before it goes
3. Short. Everything it could say is on the page, and a text that repeats the
   page is one nobody opens the page from
4. Skipped, not half-sent, when the install has no `APP_URL` — and the claim
   released, so it goes out once the variable is set rather than being lost

---

## Definition of done

- All acceptance criteria pass
- The page opened in a phone-sized browser from a context with no cookies, confirming it answers with no session and raises no CSP violation
- The rendered HTML checked for the price, the driver's phone number and the margin
- One link sent to a real client before it is offered as a feature
