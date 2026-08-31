# Phase 5 — Telegram Operations Bot

**Goal:** drivers receive jobs, accept them, report status and submit expenses in Telegram. Status stops being manual admin work, and wait time becomes billable automatically.

**Depends on:** Phase 4 — wait-time billing needs the rate card's free-wait allowance.

**Scope note:** Telegram is for **drivers and internal ops only**. UK Telegram penetration is too low to ask clients to install it. Client messaging is email and SMS — see 5.10.

---

## 5.1 Bot setup

**Acceptance criteria**
1. Two bots via @BotFather: an ops bot for drivers and an admin bot for staff
2. Tokens in env, never in the repo
3. `POST /api/telegram/webhook` verifies `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` and rejects mismatches with 401 **before parsing the body**
4. Webhook registered at deploy time via a setup script, not by hand —
   `scripts/register-webhook.ts`, or the button in Settings → Telegram. Both
   derive the address from `APP_URL` and confirm it afterwards
5. Always responds 200 within 5 seconds; slow work is queued
6. grammY in webhook mode; polling is not used in production
7. Every inbound update is logged with chat id, type and outcome

## 5.2 Driver account linking

**Acceptance criteria**
1. "Generate Telegram link" on the driver record creates a `LinkToken` valid for 7 days and returns `https://t.me/WeLuxOpsBot?start=drv_<token>`
2. The link can be copied or sent by SMS
3. `/start drv_<token>` validates the token, binds `telegramChatId` to the driver, marks the token used and confirms by name
4. An expired or already-used token gets a clear message telling the driver to ask ops for a new one
5. A chat id already bound to another driver is rejected
6. The driver list shows a Telegram-linked indicator
7. `/unlink` clears the binding, notifying ops
8. Unlinked drivers are excluded from bot notifications and flagged in the dispatch view

## 5.3 Job assignment with acceptance

**Acceptance criteria**
1. Assigning a job to a linked driver sends the job brief: reference, date and time (London), pickup, dropoff, client or passenger name, vehicle, flight number where relevant, notes, driver pay
2. Inline keyboard: **Accept** and **Decline**
3. Accept writes an `ACCEPTED` event, sets status `ACCEPTED`, edits the message to confirm
4. Decline writes a `DECLINED` event, clears the driver from the job, returns it to `PENDING` and alerts ops on the admin bot
5. No response within a configurable window (default 15 minutes) alerts ops — it does not auto-reassign
6. Reassigning notifies the previous driver that the job has been withdrawn
7. Any change to a job the driver has accepted sends an update message highlighting what changed
8. Cancelling notifies the driver immediately

## 5.4 Status buttons

The highest-value feature in the phase.

**Acceptance criteria**
1. From two hours before pickup, the driver's job message carries the status keyboard
2. Buttons appear in sequence, each revealing the next: **On My Way** → **Arrived** → **Passenger On Board** → **Completed**
3. Each tap writes a `JobEvent` with type, timestamp and location where the driver has shared it
4. Job status updates: `ON_WAY` → `IN_PROGRESS`, `COMPLETED` → `COMPLETED`
5. The message is edited in place to show progress — no chat spam
6. Ops sees status changes live in the dispatch view without refreshing
7. A tap out of sequence is rejected with a short explanation
8. A tap on an already-completed job is ignored gracefully

## 5.5 Automatic wait-time billing

**Acceptance criteria**
1. On `POB`, wait minutes are computed as `minutes(ARRIVED → POB)`
2. Billable minutes are `max(0, waitMinutes − rule.freeWaitMinutes)`, the allowance coming from the matched rate card rule
3. `waitTimePence = billableMinutes × rule.waitPerMinutePence`, written to `JobFinance` and included in the total
4. Wait time on the finance panel becomes read-only once auto-calculated, with the derivation shown and an `ACCOUNTS` override that records who changed it and why
5. Airport transfers default to a 45-minute allowance, others to 15 — both configurable per rate card rule
6. The driver's completion message states the wait time recorded
7. Full unit tests, including zero wait, wait under the allowance, and a missing `ARRIVED` event

## 5.6 Expense capture

**Acceptance criteria**
1. A photo sent while the driver has an active job creates a `JobExpense` with the image stored in R2
2. The bot replies asking for kind (inline keyboard: toll, parking, congestion charge, ULEZ, fuel, other) and amount
3. The amount is parsed from text — `12.50`, `£12.50` and `12,50` all accepted
4. Expenses appear on the job detail with the receipt thumbnail
5. Expenses marked recoverable flow into the job's extra charges; those marked driver-reimbursable flow into the payout
6. Ops can approve or reject, and rejection notifies the driver with a reason
7. A photo sent with no active job prompts the driver to specify which job

## 5.7 Live location and client ETA

**Acceptance criteria**
1. The bot requests live location sharing when the driver taps On My Way
2. Location updates are stored as position pings against the job
3. The dispatch view shows the driver's last known position and time
4. ETA to pickup calculated from the position; the client is optionally texted "Your driver is N minutes away"
5. Location retention is 30 days, then purged — a documented privacy position
6. Drivers can decline location sharing; every other feature continues to work

## 5.8 Compliance chasing

**Acceptance criteria**
1. `/api/cron/document-expiry` messages drivers at 30, 14 and 7 days before expiry, and daily once expired
2. The message names the document and date and asks for a photo of the renewal
3. A photo sent in reply creates a `Document` of that type, superseding the old one
4. The bot asks for the new expiry date and validates it is in the future
5. Ops is notified to verify; the document is marked pending until verified
6. An expired-document driver assigned to a job is blocked, and ops sees why

## 5.9 Admin bot

**Acceptance criteria**
1. Staff link their own Telegram to their user account, gated by role.
   Self-service, on `/profile`, reachable by every role the bot serves —
   *not* an administrator issuing links on somebody's behalf. A driver has no
   login, which is why ops issues theirs; staff all have one, so a link never
   has to travel and therefore never should. An administrator can revoke
   another user's binding from their record, and deactivating an account
   clears it.
2. Commands: `/today`, `/tomorrow`, `/unassigned`, `/unpriced`, `/expiring`, `/driver <name>`, `/job <reference>`, `/unlink`
3. Push alerts: job within 3 hours with no driver; accepted driver not tapping On My Way 15 minutes before pickup; job declined; invoice overdue
4. Alert thresholds configurable in Settings
5. Alerts go to a group chat if one is configured, otherwise to individuals

## 5.10 Client messaging over email and SMS

**Acceptance criteria**
1. Transactional email provider (Resend or Postmark) configured in Settings
2. SMS provider (Twilio) configured in Settings
3. Templates: booking confirmation, driver assigned with vehicle and contact, driver en route with ETA, invoice, payment reminder
4. Per-client channel preference: email, SMS, both or none
5. Message history per client, mirroring what the Telegram log does for drivers
6. All sending is opt-in per template in Settings, with everything off by default
7. Delivery failures are logged and surfaced to ops

## 5.11 Settings changes

**Acceptance criteria**
1. The WhatsApp block is replaced by a Telegram block: ops bot token, admin bot token, dispatch group chat id, webhook URL (read-only), test-connection control, enable toggle
2. A separate Email/SMS block holds the client-messaging provider credentials
3. Automation toggles: notify driver on assignment, require acceptance, chase document expiry, send weekly statements, alert on unassigned jobs, request live location
4. Tokens are write-only in the UI — displayed masked, never returned by the API

---

## Definition of done

- All acceptance criteria pass
- A test driver completes a full lifecycle in Telegram: link → receive → accept → on way → arrived → POB → complete → submit an expense
- Wait time verified as calculated and billed correctly against a known scenario
- Webhook rejects unsigned requests, proven by test
- At least 10 real drivers linked and running live before wider rollout
