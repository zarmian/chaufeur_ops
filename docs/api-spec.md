# API Contracts

Next.js App Router. Most reads happen in Server Components and Server Actions; the routes below exist where an external consumer, a client-side table or a webhook needs them.

## Conventions

- Base path `/api`
- Auth by session cookie (dashboard) or `Authorization: Bearer` (cron and integrations)
- All money in the payload is **integer pence**, in fields ending `_pence`
- All timestamps are **ISO 8601 UTC** with a `Z` suffix
- Errors return `{ error: { code, message, fields? } }` with the appropriate status
- List endpoints return `{ data: [...], page, pageSize, total }`
- Mutations are validated by the same Zod schema used by the form

## Standard error codes

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Role lacks permission |
| `NOT_FOUND` | 404 | |
| `VALIDATION_FAILED` | 422 | `fields` carries per-field messages |
| `INVALID_TRANSITION` | 409 | Illegal status change |
| `DOCUMENT_EXPIRED` | 409 | Driver or vehicle not compliant at `scheduledAt` |
| `PRICE_REQUIRED` | 409 | Completing a job with no price and no `zeroValueReason` |
| `INVOICE_LOCKED` | 409 | Editing a `SENT` or `PAID` invoice |

---

## Jobs

### `GET /api/jobs`
Server-side paginated list. This backs the main table — it must never return everything.

Query: `page` `pageSize` (max 100) `q` `status` `jobType` `driverId` `clientId` `accountId` `from` `to` `unpriced=true` `sort` `dir`

```json
{
  "data": [{
    "id": "clx...", "reference": "WLX-000767",
    "scheduledAt": "2026-08-02T13:30:00Z",
    "jobType": "AIRPORT_TRANSFER", "status": "ASSIGNED",
    "pickupText": "Heathrow T5", "dropoffText": "The Dorchester",
    "client": { "id": "clx...", "name": "Mr Williams" },
    "account": { "id": "clx...", "name": "Welux" },
    "driver": { "id": "clx...", "name": "Nasir Hafeez" },
    "vehicle": { "id": "clx...", "registration": "KR22 RRZ", "make": "Mercedes Benz", "model": "EQE" },
    "clientPricePence": 12500, "driverPricePence": 8000,
    "grossProfitPence": 4500, "isUnpriced": false
  }],
  "page": 1, "pageSize": 50, "total": 704
}
```

### `POST /api/jobs`
Creates a job. `clientPricePence` and `driverPricePence` are optional but the response warns when absent.

```json
{
  "clientId": "clx...", "accountId": "clx...",
  "jobType": "AIRPORT_TRANSFER",
  "scheduledAt": "2026-08-02T13:30:00Z",
  "pickupText": "Heathrow T5", "dropoffText": "The Dorchester",
  "driverId": "clx...", "vehicleId": "clx...",
  "flightNumber": "BA216",
  "clientPricePence": 12500, "driverPricePence": 8000,
  "notes": "Meet and greet"
}
```

`201` with the created job. `409 DOCUMENT_EXPIRED` if the driver or vehicle is non-compliant at `scheduledAt`.

### `PATCH /api/jobs/:id`
Partial update. Writes an `EDITED` event and an audit entry.

### `POST /api/jobs/:id/status`
```json
{ "status": "COMPLETED", "occurredAt": "2026-08-02T15:10:00Z", "zeroValueReason": null }
```
Validates the transition, appends a `JobEvent`, updates the cached `jobs.status`. `409 PRICE_REQUIRED` when completing an unpriced job without a reason.

### `DELETE /api/jobs/:id`
Soft delete. `ADMIN` only. Refuses if the job appears on a non-draft invoice.

### `GET /api/jobs/:id/timeline`
Ordered `JobEvent` list with computed durations, including waiting time from `ARRIVED` to `POB`.

---

## Job finances

### `GET /api/jobs/:id/finance`
### `PUT /api/jobs/:id/finance`
Accepts the input fields only. Totals and gross profit are recomputed server-side and returned — anything the client sends for `totalClientPence`, `totalCostsPence` or `grossProfitPence` is ignored.

```json
{
  "baseFarePence": 12500, "extraChargesPence": 1500,
  "extraChargesNotes": "Gatwick drop charge",
  "customerHours": null, "customerRatePence": 0,
  "driverPaymentPence": 8000, "fuelCostPence": 0,
  "driverPayStatus": "UNPAID"
}
```

### `POST /api/jobs/:id/price-from-rate-card`
Resolves the matching `RateCardRule` and returns a suggested price without saving.

---

## Drivers, vehicles, documents

```
GET    /api/drivers                 list, filters: status, q, expiringWithinDays
POST   /api/drivers
PATCH  /api/drivers/:id
GET    /api/drivers/:id/schedule    ?from&to — jobs, for conflict checks
GET    /api/drivers/:id/earnings    ?from&to — jobs, hours, amount due, paid status
POST   /api/drivers/:id/telegram-link   → { url: "https://t.me/<opsBot>?start=drv_xxx" }
POST   /api/profile/telegram             own staff link → "…?start=stf_xxx"

GET    /api/vehicles
POST   /api/vehicles
PATCH  /api/vehicles/:id

POST   /api/documents               multipart: file, type, driverId|vehicleId, issuedOn, expiresOn
GET    /api/documents/:id/url       → short-lived signed R2 URL
GET    /api/compliance/expiring     ?days=30 — drivers and vehicles with lapsing documents
```

`GET /api/compliance/expiring` response:

```json
{
  "expired":  [{ "kind": "DRIVER", "id": "clx...", "name": "Aqeel Butt",
                 "documentType": "PHV_BADGE", "expiresOn": "2026-07-14", "daysRemaining": -19 }],
  "critical": [],
  "warning":  [],
  "counts": { "expired": 1, "critical": 0, "warning": 4 }
}
```

Buckets: `expired` (past), `critical` (≤7 days), `warning` (≤30 days).

---

## Invoicing

```
GET    /api/invoices                ?status&clientId&accountId&overdue=true
POST   /api/invoices                { jobIds[], clientId|accountId, issueDate, dueDate, vatRatePct, notes }
GET    /api/invoices/:id
PATCH  /api/invoices/:id            DRAFT only, else 409 INVOICE_LOCKED
POST   /api/invoices/:id/send       renders PDF, emails it, sets SENT
POST   /api/invoices/:id/payments   { amountPence, gateway, receivedAt, gatewayTxnId? }
GET    /api/invoices/:id/pdf        signed URL
GET    /api/invoices/aging          0-30 / 31-60 / 61-90 / 90+ totals by client
```

`POST /api/invoices` sums the selected jobs' `totalClientPence` server-side, computes VAT, allocates the next number from a sequence, and rejects any job already on a non-cancelled invoice.

---

## Driver payouts

```
GET    /api/payouts                 ?driverId&status&period
POST   /api/payouts/generate        { periodStart, periodEnd, driverIds?[] } — drafts for all with unpaid completed jobs
POST   /api/payouts/:id/approve
POST   /api/payouts/:id/mark-paid   { paidAt, paymentReference }
GET    /api/payouts/:id/statement   PDF signed URL
```

Marking a payout paid sets `driverPayStatus = FULLY_PAID` on every job in it, inside one transaction.

---

## Reports

```
GET /api/reports/summary     ?from&to&driverId&clientId&accountId&vehicleId
GET /api/reports/jobs        same filters, paginated detail rows
GET /api/reports/export      same filters + format=xlsx|pdf → signed URL
```

Summary response:

```json
{
  "jobCount": 141, "pricedJobCount": 138, "unpricedJobCount": 3,
  "revenuePence": 1842500, "costsPence": 1204000,
  "grossProfitPence": 638500, "marginPct": 34.65,
  "byJobType": [{ "jobType": "AIRPORT_TRANSFER", "jobCount": 88,
                  "revenuePence": 1120000, "grossProfitPence": 402000 }]
}
```

`unpricedJobCount` is deliberately prominent. A report that silently averages in zero-value jobs is how the legacy system reported £0 profit on 141 jobs.

---

## Bank reconciliation

Statement rows are never written by a `GET`, and never written twice: every
row carries a fingerprint — the bank's own reference where there is one,
otherwise a hash of date, amount and description — and an already-present
fingerprint is skipped rather than updated.

### `POST /api/reconciliation/preview`
`{ csv, mapping? }`. Writes nothing. Returns the detected layout, the count
of fresh and already-imported rows, the rows the parser could not read, and
the first 25 parsed rows. `needsMapping` is true only when the columns were
unrecognised *and* no mapping was supplied.

### `POST /api/reconciliation/import`
`{ filename, csv, mapping? }`. Writes the statement and its fresh rows,
classifying each against `BankRule`. Returns `{ statementId, imported,
duplicates, problems }`.

### `POST /api/reconciliation/:id/actions`
Form post. `intent` is one of:

| Intent | Does |
|---|---|
| `classify` | Sets the kind and counterparty by hand. Refused once allocated |
| `allocate` | Applies the invoice proposal — payments, statuses, credit — in one transaction |
| `payout` | Marks the chosen approved `DriverPayout` paid. Refuses an amount mismatch |
| `cost` | Records a `VehicleCost` against the chosen vehicle |
| `ignore` | Marks an own transfer as needing nothing |
| `undo` | Reverses everything the transaction created |

The proposal is recomputed server-side on confirm rather than trusted from
the client: the screen the operator saw is a view, and the invoices may have
moved since it rendered.

### `GET /api/reconciliation/export`
The statement with its classifications and allocations as `.xlsx`, honouring
the list's filters.

### `POST /api/reconciliation/rules`
Form post: `create`, `toggle`, `delete`.

---

## Address search

Both proxied. A Places key in the browser is a key anybody can spend, so it
never leaves the server — spec 4.8.6.9.

### `GET /api/places/suggest`
`?q=&session=`. Saved `Location` rows first, then the configured provider,
de-duplicated on the primary line. A query under three characters returns
nothing without asking the provider. A provider failure degrades to the
saved list and reports `warning` rather than erroring.

### `POST /api/places/resolve`
`{ id, session }`. Closes the provider session, so the keystrokes that led
here are billed as one. Saves the place as a `Location` if it is not already
one, resolves its postcode to a zone, and returns the formatted address,
postcode, coordinates, `locationId` and `zoneId`.

---

## Telegram

### `POST /api/telegram/webhook`
Public but verified by the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`. Reject anything else with 401 before parsing.

Handles:

| Update | Action |
|---|---|
| `/start drv_<token>` | Validate `LinkToken`, bind `telegramChatId` to the driver, confirm |
| `callback_query` `job:<id>:accept` / `decline` | Append event, update status, notify ops on decline |
| `callback_query` `job:<id>:on_way\|arrived\|pob\|complete` | Append event with timestamp and location |
| `message` with photo | Attach to the driver's current job as a receipt, prompt for amount |
| `message` with location | Store as a position ping against the active job |
| `message` text | Append to the job's internal notes, alert ops |

Respond `200` within 5 seconds always; queue anything slow.

### `POST /api/telegram/admin-webhook`
The staff bot, on its own endpoint because it is its own token — mixing them
would mean one compromised token reaching both audiences. Same three rules.
Everything it does is read-only: somebody with a phone in a pub should be able
to see whether tomorrow is covered, and should not be able to reassign a job.

### `POST /api/drivers/:id/telegram`
Form post: `link` issues a one-time `LinkToken` valid for seven days and
returns the URL on the query string, shown once; `unlink` clears the binding.
Any outstanding unused token for the same driver is spent first, so "it says
expired" always has an answer.

### `POST /api/documents/upload`
Issues a short-lived token for **one** browser-to-Blob upload, via the Blob
SDK's `handleUpload`. Documents do not pass through the server: a Server
Action's body is capped at 1 MB by default and a Vercel Function's at 4.5 MB,
either of which a scanned certificate exceeds — which is why uploads under a
megabyte used to work and anything larger died in the framework with no
message on it.

The browser names the pathname it wants, so the route is the whole of the
access control: the caller must hold `editDocuments`; the key must be under
`documents/`, well-formed, and in the namespace of the driver or vehicle the
payload names; that record must exist; and the token itself caps the content
type and the 10 MB size, so the limits are enforced by the storage service
rather than by the browser that asked. `onUploadCompleted` is deliberately
unused — it never fires against localhost, so the row would exist in
production and not in development.

### `POST /api/profile/telegram`
Form post, one's own staff link — spec 5.9.1. `link` issues a one-time
`StaffLinkToken` valid for 48 hours and returns the URL on the query string,
shown once; `unlink` clears the binding.

**There is no id in the path and none in the form.** The account is whoever is
signed in, so there is no parameter to tamper with and no capability check to
get wrong: a route that accepted a target would need one to stop a VIEWER
minting a link for an ACCOUNTS account, and that check would be one refactor
away from being dropped. Guarded by `viewJobs`, the weakest capability every
role holds, because the staff bot answers every role.

### `POST /api/settings/users/:id/telegram`
Form post, `unlink` only — an administrator revoking somebody else's binding,
for the phone that has left with somebody who has not. `link` is refused with
an explanation rather than silently ignored: minting for another person is a
deliberate omission, not a gap. Requires `manageUsers`.

### `POST /api/settings/telegram`
Form post. Tokens are write-only — stored encrypted, never returned. Enabling
the bot without an ops token is refused: a bot that cannot send anything would
leave every driver silently unreachable with the screen claiming otherwise.

### `POST /api/settings/messaging`
Form post. Per-template opt-in for client email and SMS, all off by default,
plus the Twilio credentials. Twilio is refused unless the SID, token and from
number are all present.

### `GET /api/cron/telegram`
Requires the cron bearer token. Chases expiring documents at 30, 14 and 7 days
then daily once expired; alerts on unassigned jobs and unanswered assignments;
purges position pings past the retention window. Each step is independent and
none may stop the others — a failure to chase documents must not leave pings
unpurged, which is a privacy commitment rather than housekeeping.

---

## Cron

All require `Authorization: Bearer ${CRON_SECRET}`.

| Route | Schedule | Does |
|---|---|---|
| `/api/cron/document-expiry` | daily 08:00 | Messages drivers at 30/14/7 days; emails ops the summary |
| `/api/cron/unassigned-jobs` | hourly | Alerts ops to jobs within 24h with no driver |
| `/api/cron/driver-statements` | Sundays 18:00 | Generates and sends weekly payout statements |
| `/api/cron/invoice-reminders` | daily 09:00 | Chases invoices overdue by the configured number of days |
| `/api/cron/unpriced-digest` | daily 07:00 | Emails ops the list of completed-but-unpriced jobs |
| `/api/cron/telegram` | daily 08:00 | Document chasing, unassigned and unanswered alerts, position purge |

## Rate limiting

- Auth endpoints: 5 attempts per 15 minutes per IP
- Telegram webhook: 30 updates per second per chat, then drop
- Export endpoints: 10 per hour per user — they are expensive
