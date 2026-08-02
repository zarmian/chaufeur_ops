# WeLux Chauffeurs — Job System Reference & Enhancement Roadmap

**URL:** jobs.weluxchauffeurs.co.uk (front end) · api.weluxchauffeurs.co.uk (REST backend)
**Type:** Single-page admin dashboard, one login (`Admin User`), no role separation
**Audited:** 1 August 2026 against live data

**Part 1** documents the system as it exists today.
**Part 2** is the phased enhancement roadmap.
**Part 3** is the Telegram architecture in detail.

---

# PART 1 — THE SYSTEM AS IT IS

## 1. Architecture at a glance

A static SPA that loads everything into one page and shows/hides sections via the left nav. All data is fetched from a separate API host. Eight modules:

| Module | Purpose |
|---|---|
| Overview | Master job table + per-job actions + invoice creation |
| Job Management | Create-new-job form only (no list) |
| Driver Management | Driver CRUD, card layout |
| Car Management | Vehicle CRUD, card layout |
| Reports | Date/driver/client/car filtering, P&L totals, PDF/Excel export |
| Payments | Gateway status + transaction log (read-only) |
| WhatsApp | Template messaging + send history |
| Settings | API credentials + automation toggles |

**Current volume:** ~704 jobs (IDs running to #766), ~195 drivers, ~195 vehicles. Matching driver and vehicle counts indicate an owner-driver model — one car per driver.

## 2. Jobs

### Creating a job (Job Management → Add New Job)

| Field | Type | Notes |
|---|---|---|
| Client Name | text | free text, no client master record |
| Client Contact | text | phone/email, free text |
| Job Date | date | |
| Pickup Time | time | |
| Pickup Location | text | free text — no address validation or geocoding |
| Dropoff Location | text | free text |
| Job Type | select | `As Directed` · `Transfer` · `Airport Transfer` |
| Driver | searchable dropdown | from driver master |
| Job Notes | text | optional |
| Car | searchable dropdown | from vehicle master |
| Booker | text | free text — who took the booking (e.g. "Welux", "Montclares", "Mr Freddy") |

No price field at creation. Money is entered separately, after the fact — see §5.

### Job statuses

`Pending` → `In Progress` → `Completed` · `Cancelled`

Set only via the Edit Job modal. No driver-facing app pushes status, so every status change is a manual admin action.

### Overview table

Columns: Job ID · Job Type · Date & Time · Pickup · Dropoff · Client Name · Driver Name · Car Reg · Booker · Notes · Status · Actions.
Free-text search across client name, driver name and booker. No status or date filter here — that lives in Reports.

### Per-job actions (five icons)

| Icon | Function | Behaviour |
|---|---|---|
| £ | `openFinanceModal` | full revenue/cost/profit entry — the money screen |
| Pencil | `editJob` | edit every field incl. status, driver, car, booker |
| Chain | `copyJobLink` | copies a shareable link to the job |
| WhatsApp | `sendWhatsAppToJob(id,'job_confirmation')` | fires the Job Confirmation template |
| Bin | `deleteJob` | hard delete |

## 3. Drivers

Card list with Edit / Delete and an Active badge. Fields: Name, Phone, Email, Address, Driving Licence picture, PHV Licence picture, PHV Licence Number, Assigned Car.

The system doubles as a compliance document store — licence images sit on the driver record. There are no expiry date fields, so nothing warns when a PHV licence lapses.

## 4. Vehicles

Card list with Edit / Delete. Fields: Make, Model, Variant, Registration Number, PHV Licence picture, PHV Licence Number, V5 Logbook picture, Insurance picture, MOT picture.

Fleet is overwhelmingly Mercedes (EQV, EQE, EQS, S/E/V Class) plus Range Rovers and a BMW. Same compliance-store pattern, same gap: images with no expiry dates or renewal alerts.

## 5. Job finances — the core money model

Opened per job from the £ icon.

**Revenue (client charges)**
Base Fare · Wait Time Charges · Extra Charges + notes · Customer Hours × Customer Rate Per Hour → **Total Client Charge**

**Costs (expenses)**
Driver Payment · Fuel Cost · Other Expenses + notes · Driver Hours × Driver Rate Per Hour → **Total Costs**

**Result:** Gross Profit = Total Client Charge − Total Costs

**Driver payment details:** Payment Status (`Unpaid` / `Partially Paid` / `Fully Paid`), Payment Method (`Cash` / `Card` / `Bank Transfer` / `Invoice`), Payment Date, Payment Notes.

The single most important structural fact about this system: revenue and driver cost live on the *job* record and are typed in manually per job. Nothing derives from a tariff, mileage or rate card. If the finance modal isn't filled in, the job is worth £0 everywhere downstream.

## 6. Invoicing

`Create Invoice` on Overview opens a builder: select jobs (checkbox list with Select All, each row showing date, type, driver, status and £ value) → client name and contact auto-populate → invoice date, due date (defaults +14 days) → total amount auto-sums → status `Draft` / `Sent` / `Paid` / `Overdue` → notes → Generate Invoice.

Multi-job consolidated invoicing, built for corporate accounts on monthly terms. No VAT line. No invoice list was found anywhere in the UI after generation.

## 7. Reports

Filters: Start Date, End Date, Driver, Client, Car. Summary tiles: Jobs Found · Total Revenue · Total Costs · Gross Profit. Breakdown table plus PDF and Excel export. This is the only P&L view, and it is purely a roll-up of the per-job finance modal.

## 8. Payments

Gateway cards for **Revolut Business** and **SumUp**, both **Disabled**. Transaction table (Transaction ID, Invoice #, Client, Amount, Gateway, Status, Date) — empty. Read-only; configuration is in Settings.

## 9. WhatsApp

API status **Disabled**. Three templates: Job Confirmation (to client on creation), Driver Assignment (to driver on assignment), Payment Reminder (to client). Manual composer and message history — empty.

## 10. Settings

**WhatsApp Business API:** Provider (`Twilio` / `MessageBird` / `360dialog`), Account SID, Auth Token, WhatsApp Number, enable toggle. Holds Twilio placeholders (`YOUR_TWILIO_ACCOUNT_SID`, sandbox number `+14155238886`), unchecked.

**Revolut Business API:** API Key, Environment (Sandbox/Production), toggle. Sandbox, disabled.
**SumUp API:** API Key, Merchant Code, Environment, toggle. Placeholder, sandbox, disabled.

**Automation Settings:**
- ☑ Auto-generate invoice when job is completed *(the only one enabled)*
- ☐ Auto-send invoice to client
- ☐ Auto-send WhatsApp notifications for job updates
- ☐ Auto-send payment reminders for overdue invoices
- Payment Reminder After (Days): 7

## 11. How data flows today

```
Booking taken (phone / email / booker)
   ▼
Create Job                      [client, route, time, driver, car, booker]
   ▼
Overview, status Pending
   ├─► Edit Job → In Progress → Completed        (manual)
   ▼
£ Finance modal (manual, post-job)               [charges, costs, driver payment]
   ├─► Reports (revenue / cost / gross profit)
   └─► Create Invoice (multi-job per client)
           ▼
     Draft → Sent → Paid / Overdue
           ▼
     Payments (gateway log — inactive)
```

## 12. Findings from the audit

1. **Finance data is barely populated.** For 02/07–01/08/2026: 141 jobs, £160.00 revenue, £160.00 costs, **£0.00 gross profit**. Nearly every job reads £0.00. The modal works — it isn't being filled in, which makes Reports, invoicing and profitability blind.
2. **Every integration is off.** WhatsApp, Revolut and SumUp all hold sandbox placeholders. Auto-invoice-on-completion is ticked, but the auto-send that would make it useful is not.
3. **No client master record.** Client name and contact are free text per job, so "MR Yinka" and "Mr yinka" are separate strings.
4. **No expiry tracking on compliance documents.** PHV, MOT, insurance and V5 are images with no dates.
5. **Job pricing is fully manual** — no tariff, no mileage, no rate card. Every price is typed twice per job.
6. **Single shared admin account.** No attribution for edits or hard deletes.
7. **Hours are captured but never aggregated.** No driver-level view of hours or amounts owed.

---

# PART 2 — ENHANCEMENT ROADMAP

Six phases, ordered so that each one unblocks the next. Effort is relative sizing for one developer; treat the day ranges as indicative, not quoted.

## Phase 1 — Make the financial data real *(highest ROI, smallest build)*

Nothing else in the system is trustworthy until this is fixed. The cause of the £0 problem is structural, not behavioural: pricing is a separate, post-hoc, fourteen-field step hidden behind an icon, so it gets skipped under pressure.

| # | Feature | Detail | Effort |
|---|---|---|---|
| 1.1 | **Price at booking** | Add `Client Price (£)` and `Driver Price (£)` to the Add New Job form. Two fields, entered while the booking is still in front of you. The full finance modal stays for extras, wait time and reconciliation. | S · 1–2d |
| 1.2 | **Unpriced-job flag** | Red badge on any job where Total Client Charge = 0. "Unpriced" filter on Overview. Count tile on the dashboard header. | S · 1d |
| 1.3 | **Inline price edit** | Editable price cells directly in the Overview row so backfilling ~700 jobs doesn't mean opening a modal each time. | M · 2–3d |
| 1.4 | **Required-before-complete rule** | Block the status change to `Completed` if client price is £0, with an override for genuine zero-value jobs. | S · 0.5d |
| 1.5 | **Margin column** | Show gross profit and margin % per row on Overview and in Reports. Makes loss-making work visible at a glance. | S · 1d |

**Outcome:** Reports, invoicing and profitability start producing real numbers within a fortnight.

## Phase 2 — Compliance expiry tracking *(small build, large risk reduction)*

The system stores PHV licences, MOT, insurance and V5 as images with no dates. It cannot tell you anything is about to lapse, which makes licensing compliance a memory-based process.

| # | Feature | Detail | Effort |
|---|---|---|---|
| 2.1 | **Expiry date fields** | Driver: DVLA licence expiry, PHV badge expiry. Vehicle: MOT expiry, insurance expiry, PHV vehicle licence expiry. | S · 1d |
| 2.2 | **Expiry dashboard tile** | "Expiring within 30 days" count, click through to the list. Amber at 30 days, red at 7, black when expired. | S · 1–2d |
| 2.3 | **Assignment block** | Prevent assigning a driver or vehicle whose documents have expired. Warn (don't block) inside 14 days. | S · 1d |
| 2.4 | **Automated renewal chase** | Bot message to the driver at 30/14/7 days asking for a photo of the renewed document, which files itself against the record. *(Depends on Phase 4.)* | M · 2d |

## Phase 3 — Give the data a spine

| # | Feature | Detail | Effort |
|---|---|---|---|
| 3.1 | **Client master** | Proper client records: name, contacts, billing email, VAT number, payment terms, default rate card. Autocomplete on job creation. One-off dedupe of the existing free-text names. | M · 4–6d |
| 3.2 | **Booker / account master** | Same treatment for bookers — these are your corporate accounts and the natural unit for consolidated invoicing and account-level margin. | M · 2–3d |
| 3.3 | **Rate card engine** | Job type × vehicle class × route zone (Heathrow, Gatwick, City, Central) auto-fills base fare and driver rate. Manual override always available. Removes the double-entry that causes 1.1 to be skipped in the first place. | L · 6–10d |
| 3.4 | **Driver payout statements** | Per-driver, date-ranged view summing driver payment across jobs, with batch "mark as paid" and a downloadable/sendable PDF statement. Paying drivers is currently a job-by-job task. | M · 4–5d |
| 3.5 | **Client & account P&L** | Revenue, cost and margin grouped by client and by booker. Tells you which accounts are actually worth having. | M · 3d |

## Phase 4 — Telegram operations bot

Replaces the WhatsApp module. Full architecture in Part 3.

| # | Feature | Detail | Effort |
|---|---|---|---|
| 4.1 | Bot setup, webhook, driver account linking | M · 3–4d |
| 4.2 | Job assignment with Accept / Decline buttons | M · 3d |
| 4.3 | Status buttons (On Way → Arrived → POB → Completed) with timestamps | M · 3–4d |
| 4.4 | Auto-calculated wait time from Arrived → POB | S · 1d |
| 4.5 | Receipt and expense capture by photo | M · 3d |
| 4.6 | Live location sharing and client ETA | M · 3–4d |
| 4.7 | Dispatch group with claimable unassigned jobs | M · 3d |
| 4.8 | Admin query bot ("jobs today", "unpriced", "unassigned") | M · 2–3d |
| 4.9 | Weekly driver payout statement delivery | S · 1d |

## Phase 5 — Dispatch and performance

| # | Feature | Detail | Effort |
|---|---|---|---|
| 5.1 | **Day / dispatch view** | Timeline by driver for today and tomorrow. A reverse-chronological table is not a dispatch tool. | L · 6–8d |
| 5.2 | **Conflict detection** | Warn on save when a driver or vehicle is already committed at that time, including a configurable buffer for travel between jobs. | M · 2–3d |
| 5.3 | **Overview filters + pagination** | Date range, status, driver, client filters; server-side pagination or virtual scrolling. 704 rows render at once today and it will only get worse. | M · 3–4d |
| 5.4 | **Recurring / return journeys** | Duplicate a job, create a return leg, or set a weekly repeat. Common in chauffeur work and currently full re-entry. | M · 3d |
| 5.5 | **Address book & saved locations** | Reusable pickup points (terminals, hotels, client home/office) to end free-text address entry. | M · 3–4d |

## Phase 6 — Finance governance and controls

| # | Feature | Detail | Effort |
|---|---|---|---|
| 6.1 | **Invoice ledger** | A list of every invoice with number, client, dates, amount, status and aging buckets (0–30 / 31–60 / 61–90 / 90+). Currently invoices vanish after generation. | M · 4–5d |
| 6.2 | **VAT handling** | Net / VAT / gross on invoices, VAT number on client records, VAT summary in Reports. Non-negotiable for a UK business. | M · 3d |
| 6.3 | **Users and roles** | Individual logins with Admin / Operations / Accounts roles. One shared account means no attribution. | M · 4–5d |
| 6.4 | **Audit log + soft delete** | Record who changed what and when; replace hard delete with soft delete and a restore option. | M · 3–4d |
| 6.5 | **Accounting export** | Xero or QuickBooks-format export rather than generic Excel. | M · 3–4d |
| 6.6 | **Switch on payments** | Move Revolut and SumUp to production credentials, enable payment links on invoices, enable overdue reminders. | S · 1–2d + gateway onboarding |

## Suggested sequencing

```
Phase 1  ██████                     data becomes real
Phase 2    ████                     legal risk closed
Phase 3      ████████████           structural spine
Phase 4          ██████████         driver automation
Phase 5                ████████     dispatch & scale
Phase 6                    ██████   finance controls
```

Phases 1 and 2 are small enough to run together and should not wait on anything. Phase 3.3 (rate card) is the largest single item and the one that makes everything upstream of it faster forever.

## Data model additions implied

**New tables:** `clients`, `bookers`, `rate_cards`, `invoices`, `invoice_lines`, `users`, `audit_log`, `job_events`

**Changed columns**
- `jobs`: `client_id`, `booker_id`, `client_price`, `driver_price`, `rate_card_id`, `assigned_at`, `accepted_at`, `on_way_at`, `arrived_at`, `pob_at`, `completed_at`, `telegram_message_id`, `deleted_at`
- `drivers`: `telegram_chat_id`, `dvla_licence_expiry`, `phv_badge_expiry`
- `vehicles`: `mot_expiry`, `insurance_expiry`, `phv_vehicle_expiry`

---

# PART 3 — TELEGRAM AS THE OPERATIONS CHANNEL

## Why Telegram over WhatsApp — with one important caveat

Telegram's Bot API is a materially better fit for the *driver-facing* half of this system:

| | WhatsApp Business API | Telegram Bot API |
|---|---|---|
| Cost | Per-conversation fees via Twilio | Free, unlimited |
| Setup | Meta Business verification, number provisioning, template pre-approval | Message @BotFather, receive a token — minutes |
| Message templates | Every template needs Meta approval; changes need re-approval | No approval, no restrictions |
| Session rules | 24-hour customer service window | None |
| Interactive buttons | Limited, template-bound | Full inline keyboards, unrestricted |
| Two-way | Constrained | Native |
| File handling | Basic | Documents, photos, up to 2GB |
| Location | Static only | **Live location streaming** |
| Group workflows | Weak | Groups, channels, topics |

**The caveat, stated plainly:** WhatsApp has near-universal penetration in the UK; Telegram does not. Most of your clients will not have Telegram installed and should not be asked to.

**So the correct split is:**
- **Telegram → drivers and internal ops.** Your drivers are a known, repeat, ~195-person group who can be onboarded once. This is where all the automation value is.
- **Email and SMS → clients.** Booking confirmations, invoices, payment links. Add WhatsApp for clients later if you want it, on top of the same webhook layer.

Framing it as "Telegram replaces the WhatsApp module" is only half right — it replaces the *driver* messaging, and client messaging should move to email/SMS, which is cheaper and more reliable than either.

## Driver onboarding flow

1. Admin generates a one-time deep link on the driver's record: `t.me/WeLuxOpsBot?start=drv_<token>`
2. Link is sent to the driver once, by SMS or WhatsApp
3. Driver taps it, the bot opens, `/start drv_<token>` fires
4. Backend validates the token and stores `telegram_chat_id` on the driver record
5. Bot confirms: "You're linked, Nasir. You'll get your jobs here."

One-time, self-service, no admin follow-up.

## What Telegram unlocks that templates cannot

### 1. Job assignment with acceptance tracking
Job assigned → driver receives the full brief with **Accept** and **Decline** buttons. Acceptance is recorded with a timestamp. If declined or unanswered after N minutes, the job returns to the dispatch pool and ops is alerted. Today, assignment is a message into the void with no confirmation loop.

### 2. Status buttons that fill in your data for you
```
🚗 Job #767 · 14:30 · Heathrow T5 → The Dorchester
   Mr Williams · Mercedes EQE (KR22 RRZ)

   [ On My Way ]  [ Arrived ]  [ Passenger On Board ]  [ Completed ]
```
Each tap writes a timestamp. Three things follow automatically:
- Job status stops being a manual admin task
- **Wait time is calculated from `Arrived` → `POB` and pushed straight into the finance modal's Wait Time Charges field** — a revenue line you are almost certainly under-billing today
- Actual job duration feeds the hourly billing on `As Directed` work instead of being estimated

This one feature closes two of the audit findings at once.

### 3. Expense capture by photo
Driver photographs a parking ticket or toll receipt in the chat. The bot attaches it to the job, prompts for the amount (or OCRs it), and files it under Extra Charges with the image as evidence. Recoverable costs stop leaking.

### 4. Live location and client ETA
Telegram supports live location streaming. Driver shares location on the way to pickup; the system calculates an ETA and can text the client "Your driver is 8 minutes away." Basic vehicle tracking for zero infrastructure cost.

### 5. Compliance chasing that closes itself
Bot messages the driver 30 days before PHV or MOT expiry: "Your PHV badge expires 14 Sept — send a photo of the renewal here." Driver photographs it, the image files against the record and the expiry date updates. The compliance store maintains itself.

### 6. Dispatch group
A Telegram group containing all active drivers. Unallocated jobs broadcast with a **Claim** button; first tap wins and the message updates to show who took it. Fills last-minute gaps without a phone round-robin.

### 7. Weekly payout statements
Every Sunday the bot sends each driver a PDF: jobs completed, hours, amount due, payment status. Removes a recurring admin task and most "what am I owed?" queries.

### 8. Admin control bot
A separate bot for you and the ops team:
```
/today          jobs scheduled today, with status
/unassigned     jobs with no driver in the next 24h
/unpriced       completed jobs with no client price
/expiring       documents lapsing in 30 days
/driver Nasir   this week's jobs, hours and amount owed
```
Plus push alerts: unassigned job within 3 hours, driver hasn't tapped "On My Way" 15 minutes before pickup, invoice overdue.

## Technical shape

```
Telegram  ──webhook──►  /api/telegram/webhook
                              │
                              ├─ callback_query   → button taps → job status + timestamps
                              ├─ message          → text, photos, documents
                              ├─ location         → live driver position
                              └─ /start <token>   → account linking
                              │
                        Jobs / Drivers / Finance
                              │
                        Telegram sendMessage / editMessageText
```

Requirements: a bot token from @BotFather, one public HTTPS webhook endpoint, and a `telegram_chat_id` column on drivers. No verification process, no per-message cost, no template approval queue.

## Settings module changes

Replace the WhatsApp Business API block with:

- **Telegram Bot Token** (ops bot)
- **Telegram Admin Bot Token** (optional, separate)
- **Dispatch Group Chat ID**
- **Webhook URL** (read-only, with a "Test connection" button)
- Enable toggle
- Automation switches: notify driver on assignment · require job acceptance · chase document expiry · send weekly payout statements · alert on unassigned jobs

Client-facing messaging moves to a separate **Email / SMS** block: transactional email provider credentials, SMS provider credentials, and the existing auto-send-invoice and payment-reminder toggles pointed at those instead.

---

## The three things that matter most

If everything else waits: **price at booking** (1.1), **document expiry dates** (2.1), and **the Telegram status buttons** (4.3). The first makes your reporting real, the second protects your licence, and the third makes the first one nearly automatic.
