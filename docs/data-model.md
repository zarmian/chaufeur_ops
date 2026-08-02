# Data Model

PostgreSQL via Prisma. Money in integer pence, timestamps in UTC, soft deletes throughout.

## Design notes before the schema

**Why `job_finances` is a separate 1:1 table.** The finance record has eighteen columns, is edited by a different role than the operational job fields, and is the thing we most need a clean audit trail on. Splitting it keeps the `jobs` table readable and lets us permission the two independently.

**Why `job_events` exists.** Job status in the legacy system is a single mutable field, so there is no record of when anything happened. The event log is what makes wait-time billing, driver punctuality and dispatch analytics possible. `jobs.status` is a denormalised cache of the latest event, maintained in the same transaction.

**Why `client_price_pence` sits on `jobs` as well as in `job_finances`.** The booking-time price is the commercial agreement; the finance record is the reconciled actual including extras and wait time. They start equal and diverge. Keeping the booking price on the job means it can be captured in one field on the booking form without instantiating a whole finance record.

**Why `Account` and not `Booker`.** The legacy free-text "Booker" field holds a mix of WeLux's own brand, partner agencies and individual bookers. These are billing relationships, so they are modelled as accounts.

---

## Enums

```prisma
enum UserRole      { ADMIN OPS ACCOUNTS VIEWER }

enum JobType       { AS_DIRECTED TRANSFER AIRPORT_TRANSFER }

enum JobStatus     { DRAFT PENDING ASSIGNED ACCEPTED IN_PROGRESS COMPLETED CANCELLED NO_SHOW }

enum JobEventType  { CREATED ASSIGNED ACCEPTED DECLINED ON_WAY ARRIVED POB COMPLETED
                     CANCELLED NO_SHOW EDITED PRICE_SET }

enum ActorType     { USER DRIVER SYSTEM }

enum DriverStatus  { ACTIVE INACTIVE SUSPENDED }

enum VehicleStatus { ACTIVE OFF_ROAD RETIRED }

enum VehicleClass  { SALOON EXECUTIVE LUXURY MPV SUV ELECTRIC_EXECUTIVE }

enum DocumentType  { DVLA_LICENCE PHV_BADGE PHV_VEHICLE V5_LOGBOOK INSURANCE MOT DBS OTHER }

enum PayStatus     { UNPAID PARTIALLY_PAID FULLY_PAID }

enum PayMethod     { CASH CARD BANK_TRANSFER INVOICE }

enum InvoiceStatus { DRAFT SENT PAID PART_PAID OVERDUE CANCELLED }

enum AccountKind   { INTERNAL AGENCY CORPORATE INDIVIDUAL }

enum PayoutStatus  { DRAFT APPROVED PAID }

enum ExpenseKind   { TOLL PARKING FUEL CONGESTION_CHARGE ULEZ WAITING OTHER }
```

---

## Schema

### People and access

```prisma
model User {
  id           String    @id @default(cuid())
  email        String    @unique
  passwordHash String
  name         String
  role         UserRole  @default(VIEWER)
  active       Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())
  deletedAt    DateTime?

  auditEntries AuditLog[]
  createdJobs  Job[]     @relation("JobCreatedBy")
}
```

### Commercial relationships

```prisma
model Client {
  id               String    @id @default(cuid())
  name             String
  normalisedName   String              // lowercase, punctuation stripped — for dedupe
  contactPhone     String?
  contactEmail     String?
  billingEmail     String?
  billingAddress   String?
  vatNumber        String?
  paymentTermsDays Int       @default(14)
  defaultAccountId String?
  notes            String?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  deletedAt        DateTime?

  defaultAccount   Account?  @relation(fields: [defaultAccountId], references: [id])
  jobs             Job[]
  invoices         Invoice[]

  @@index([normalisedName])
}

model Account {
  id               String      @id @default(cuid())
  name             String      @unique
  kind             AccountKind @default(INTERNAL)
  contactName      String?
  contactPhone     String?
  contactEmail     String?
  billingEmail     String?
  billingAddress   String?
  vatNumber        String?
  paymentTermsDays Int         @default(14)
  rateCardId       String?
  commissionPct    Decimal?    @db.Decimal(5,2)   // agency margin, not money — Decimal is correct here
  active           Boolean     @default(true)
  createdAt        DateTime    @default(now())
  deletedAt        DateTime?

  rateCard         RateCard?   @relation(fields: [rateCardId], references: [id])
  jobs             Job[]
  clients          Client[]
  invoices         Invoice[]
}
```

### Fleet and drivers

```prisma
model Driver {
  id                 String       @id @default(cuid())
  reference          String       @unique          // human-facing, e.g. DRV-0147
  name               String
  phone              String
  email              String?
  address            String?

  dvlaLicenceNumber  String?
  dvlaLicenceExpiry  DateTime?    @db.Date
  phvBadgeNumber     String?
  phvBadgeExpiry     DateTime?    @db.Date
  phvIssuingAuthority String?                      // e.g. TfL

  assignedVehicleId  String?
  telegramChatId     BigInt?      @unique
  telegramLinkedAt   DateTime?

  status             DriverStatus @default(ACTIVE)
  notes              String?
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
  deletedAt          DateTime?

  assignedVehicle    Vehicle?     @relation(fields: [assignedVehicleId], references: [id])
  documents          Document[]
  jobs               Job[]
  payouts            DriverPayout[]

  @@index([status])
  @@index([phvBadgeExpiry])
}

model Vehicle {
  id                 String        @id @default(cuid())
  registration       String        @unique
  make               String
  model              String
  variant            String?
  vehicleClass       VehicleClass  @default(EXECUTIVE)
  colour             String?
  seats              Int           @default(4)

  phvLicenceNumber   String?
  phvLicenceExpiry   DateTime?     @db.Date
  motExpiry          DateTime?     @db.Date
  insuranceExpiry    DateTime?     @db.Date
  insurancePolicyNo  String?

  status             VehicleStatus @default(ACTIVE)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  deletedAt          DateTime?

  documents          Document[]
  drivers            Driver[]
  jobs               Job[]

  @@index([status])
  @@index([motExpiry])
  @@index([insuranceExpiry])
}

model Document {
  id           String       @id @default(cuid())
  type         DocumentType
  driverId     String?
  vehicleId    String?
  fileKey      String                      // R2 object key — never the binary itself
  fileName     String
  mimeType     String
  sizeBytes    Int
  issuedOn     DateTime?    @db.Date
  expiresOn    DateTime?    @db.Date
  uploadedById String?
  uploadedAt   DateTime     @default(now())
  supersededBy String?                     // points at the renewal
  deletedAt    DateTime?

  driver       Driver?      @relation(fields: [driverId], references: [id])
  vehicle      Vehicle?     @relation(fields: [vehicleId], references: [id])

  @@index([expiresOn])
  @@index([driverId, type])
  @@index([vehicleId, type])
}
```

### Locations and pricing

```prisma
model Location {
  id        String    @id @default(cuid())
  label     String                        // "Heathrow T5", "The Dorchester"
  address   String
  postcode  String?
  zoneId    String?
  lat       Float?
  lng       Float?
  isAirport Boolean   @default(false)
  useCount  Int       @default(0)         // drives autocomplete ordering
  deletedAt DateTime?

  zone      Zone?     @relation(fields: [zoneId], references: [id])
}

model Zone {
  id        String   @id @default(cuid())
  name      String   @unique              // "Heathrow", "Gatwick", "Central London"
  postcodes String[]                      // prefixes matched against pickup/dropoff
  active    Boolean  @default(true)

  locations Location[]
}

model RateCard {
  id        String    @id @default(cuid())
  name      String
  activeFrom DateTime @db.Date
  activeTo   DateTime? @db.Date
  isDefault Boolean   @default(false)
  deletedAt DateTime?

  rules     RateCardRule[]
  accounts  Account[]
}

model RateCardRule {
  id                   String       @id @default(cuid())
  rateCardId           String
  jobType              JobType
  vehicleClass         VehicleClass?      // null = any class
  fromZoneId           String?            // null = any origin
  toZoneId             String?            // null = any destination

  baseFarePence        Int          @default(0)
  perHourPence         Int          @default(0)
  minimumHours         Decimal?     @db.Decimal(4,2)
  freeWaitMinutes      Int          @default(15)
  waitPerMinutePence   Int          @default(0)

  driverBasePence      Int          @default(0)
  driverPerHourPence   Int          @default(0)
  driverPctOfFare      Decimal?     @db.Decimal(5,2)   // alternative to fixed driver rate

  priority             Int          @default(0)        // higher wins when several match
  rateCard             RateCard     @relation(fields: [rateCardId], references: [id])

  @@index([rateCardId, jobType])
}
```

### Jobs

```prisma
model Job {
  id                String     @id @default(cuid())
  reference         String     @unique             // WLX-000767, preserves legacy numbering
  legacyId          Int?       @unique             // maps to the old #766 style ID

  clientId          String?
  accountId         String?
  jobType           JobType
  status            JobStatus  @default(PENDING)

  scheduledAt       DateTime                       // UTC. Display Europe/London.
  estimatedMinutes  Int?

  pickupText        String                         // as typed
  pickupLocationId  String?
  dropoffText       String
  dropoffLocationId String?
  viaText           String?

  driverId          String?
  vehicleId         String?

  passengerName     String?                        // when different from the client
  passengerPhone    String?
  passengerCount    Int?
  luggageCount      Int?
  flightNumber      String?

  clientPricePence  Int?                           // captured at booking
  driverPricePence  Int?
  rateCardRuleId    String?
  zeroValueReason   String?                        // required to complete a £0 job

  notes             String?
  internalNotes     String?

  createdById       String?
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt
  deletedAt         DateTime?

  client            Client?    @relation(fields: [clientId], references: [id])
  account           Account?   @relation(fields: [accountId], references: [id])
  driver            Driver?    @relation(fields: [driverId], references: [id])
  vehicle           Vehicle?   @relation(fields: [vehicleId], references: [id])
  createdBy         User?      @relation("JobCreatedBy", fields: [createdById], references: [id])

  finance           JobFinance?
  events            JobEvent[]
  expenses          JobExpense[]
  invoiceLines      InvoiceLine[]
  payoutLines       DriverPayoutLine[]

  @@index([scheduledAt])
  @@index([status, scheduledAt])
  @@index([driverId, scheduledAt])
  @@index([clientId])
  @@index([accountId])
}

model JobFinance {
  id                    String     @id @default(cuid())
  jobId                 String     @unique

  // Revenue
  baseFarePence         Int        @default(0)
  waitTimePence         Int        @default(0)
  waitMinutesBilled     Int        @default(0)
  extraChargesPence     Int        @default(0)
  extraChargesNotes     String?
  customerHours         Decimal?   @db.Decimal(5,2)
  customerRatePence     Int        @default(0)
  totalClientPence      Int        @default(0)

  // Costs
  driverPaymentPence    Int        @default(0)
  fuelCostPence         Int        @default(0)
  otherExpensesPence    Int        @default(0)
  expenseNotes          String?
  driverHours           Decimal?   @db.Decimal(5,2)
  driverRatePence       Int        @default(0)
  totalCostsPence       Int        @default(0)

  grossProfitPence      Int        @default(0)

  // Driver settlement
  driverPayStatus       PayStatus  @default(UNPAID)
  driverPayMethod       PayMethod?
  driverPaidAt          DateTime?
  paymentNotes          String?

  updatedAt             DateTime   @updatedAt
  job                   Job        @relation(fields: [jobId], references: [id])

  @@index([driverPayStatus])
}

model JobEvent {
  id         String       @id @default(cuid())
  jobId      String
  type       JobEventType
  actorType  ActorType
  actorId    String?                       // user id or driver id
  occurredAt DateTime     @default(now())
  lat        Float?
  lng        Float?
  metadata   Json?

  job        Job          @relation(fields: [jobId], references: [id])

  @@index([jobId, occurredAt])
  @@index([type, occurredAt])
}

model JobExpense {
  id             String      @id @default(cuid())
  jobId          String
  kind           ExpenseKind
  amountPence    Int
  note           String?
  receiptFileKey String?
  submittedByDriverId String?
  approvedById   String?
  approvedAt     DateTime?
  rechargeToClient Boolean   @default(true)
  createdAt      DateTime    @default(now())

  job            Job         @relation(fields: [jobId], references: [id])
}
```

### Invoicing and payouts

```prisma
model Invoice {
  id           String        @id @default(cuid())
  number       String        @unique          // INV-2026-0001
  clientId     String?
  accountId    String?
  issueDate    DateTime      @db.Date
  dueDate      DateTime      @db.Date

  netPence     Int
  vatRatePct   Decimal       @default(20) @db.Decimal(5,2)
  vatPence     Int
  grossPence   Int
  paidPence    Int           @default(0)

  status       InvoiceStatus @default(DRAFT)
  notes        String?
  pdfFileKey   String?
  sentAt       DateTime?
  paidAt       DateTime?
  createdAt    DateTime      @default(now())
  deletedAt    DateTime?

  client       Client?       @relation(fields: [clientId], references: [id])
  account      Account?      @relation(fields: [accountId], references: [id])
  lines        InvoiceLine[]
  payments     Payment[]

  @@index([status, dueDate])
}

model InvoiceLine {
  id          String  @id @default(cuid())
  invoiceId   String
  jobId       String?
  description String
  amountPence Int
  sortOrder   Int     @default(0)

  invoice     Invoice @relation(fields: [invoiceId], references: [id])
  job         Job?    @relation(fields: [jobId], references: [id])
}

model Payment {
  id             String   @id @default(cuid())
  invoiceId      String
  gateway        String                    // revolut | sumup | manual
  gatewayTxnId   String?
  amountPence    Int
  status         String
  receivedAt     DateTime
  raw            Json?

  invoice        Invoice  @relation(fields: [invoiceId], references: [id])
}

model DriverPayout {
  id               String             @id @default(cuid())
  driverId         String
  periodStart      DateTime           @db.Date
  periodEnd        DateTime           @db.Date
  totalPence       Int
  status           PayoutStatus       @default(DRAFT)
  paidAt           DateTime?
  paymentReference String?
  statementFileKey String?
  createdAt        DateTime           @default(now())

  driver           Driver             @relation(fields: [driverId], references: [id])
  lines            DriverPayoutLine[]

  @@unique([driverId, periodStart, periodEnd])
}

model DriverPayoutLine {
  id          String       @id @default(cuid())
  payoutId    String
  jobId       String
  amountPence Int

  payout      DriverPayout @relation(fields: [payoutId], references: [id])
  job         Job          @relation(fields: [jobId], references: [id])
}
```

### System

```prisma
model AuditLog {
  id        String   @id @default(cuid())
  userId    String?
  entity    String                        // "Job", "Invoice", ...
  entityId  String
  action    String                        // create | update | delete | restore
  before    Json?
  after     Json?
  ip        String?
  createdAt DateTime @default(now())

  user      User?    @relation(fields: [userId], references: [id])

  @@index([entity, entityId])
  @@index([createdAt])
}

model Setting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
}

model LinkToken {
  id        String    @id @default(cuid())
  token     String    @unique
  driverId  String
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())
}
```

---

## Derived values — computed server-side, never trusted from the client

| Value | Rule |
|---|---|
| `totalClientPence` | `baseFare + waitTime + extraCharges + round(customerHours × customerRate)` |
| `totalCostsPence` | `driverPayment + fuelCost + otherExpenses + round(driverHours × driverRate)` |
| `grossProfitPence` | `totalClientPence − totalCostsPence` |
| `waitMinutesBilled` | `max(0, minutes(ARRIVED → POB) − rule.freeWaitMinutes)` |
| `waitTimePence` | `waitMinutesBilled × rule.waitPerMinutePence` |
| `jobs.status` | Denormalised from the newest `JobEvent`, written in the same transaction |
| `Invoice.vatPence` | `round(netPence × vatRatePct / 100)` — banker's rounding, half-up on `.5` |
| `Invoice.grossPence` | `netPence + vatPence` |

Rounding: always to the nearest whole penny, half away from zero. Put it in one helper (`lib/money.ts:roundPence`) and use it everywhere so totals reconcile.

## Status transitions

```
DRAFT ──► PENDING ──► ASSIGNED ──► ACCEPTED ──► IN_PROGRESS ──► COMPLETED
             │            │            │              │
             └────────────┴────────────┴──────────────┴──► CANCELLED
                                       └──────────────────► NO_SHOW
```

Rules enforced server-side:
- `ASSIGNED` requires a driver **and** a vehicle, both with valid documents at `scheduledAt`
- `IN_PROGRESS` is set by the driver's `ON_WAY` event, or manually by OPS
- `COMPLETED` requires `clientPricePence > 0` **or** a non-empty `zeroValueReason`
- A job on a `SENT` or `PAID` invoice cannot move to `CANCELLED` — raise a credit note instead

## Indexes worth having from day one

The legacy Overview renders 704 rows at once. This system paginates server-side, so these matter:

- `jobs(scheduledAt)` and `jobs(status, scheduledAt)` — the default list and dispatch views
- `jobs(driverId, scheduledAt)` — driver schedule and conflict detection
- `documents(expiresOn)` — the expiry dashboard
- `drivers(phvBadgeExpiry)`, `vehicles(motExpiry)`, `vehicles(insuranceExpiry)` — compliance tiles
- `job_events(jobId, occurredAt)` — timeline reconstruction and wait-time calculation
- `invoices(status, dueDate)` — the aging report
