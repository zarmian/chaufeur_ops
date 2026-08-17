-- Standing contracts, charged by the day.
--
-- Replaces the block-shaped first attempt. A contract has no required end —
-- most run until somebody stops them — and it is not one job spanning days
-- but a template the cron turns into one ordinary job per day. The driver and
-- the car are free to do other work around it, which is why nothing here
-- reserves them.

-- The block that is no longer how this works. `IF EXISTS` because the earlier
-- migration may or may not have reached a given database yet.
DROP INDEX IF EXISTS "Job_contractEndsAt_idx";
ALTER TABLE "Job" DROP COLUMN IF EXISTS "contractEndsAt";

CREATE TABLE "JobContract" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "label" TEXT NOT NULL,

  "clientId" TEXT,
  "accountId" TEXT,

  "jobType" "JobType" NOT NULL DEFAULT 'CONTRACT',
  "pickupText" TEXT NOT NULL,
  "dropoffText" TEXT NOT NULL,
  "pickupPostcode" TEXT,
  "dropoffPostcode" TEXT,
  "viaText" TEXT,
  -- A time of day that repeats, held as local wall clock. An instant would
  -- drift by an hour across a clocks change and put a driver at the school
  -- gates at eight.
  "startTime" TEXT NOT NULL,
  "estimatedMinutes" INTEGER,
  "passengerName" TEXT,
  "passengerPhone" TEXT,

  "driverId" TEXT,
  "vehicleId" TEXT,

  -- 0 = Sunday. Empty means every day.
  "weekdays" INTEGER[],

  "startsOn" DATE NOT NULL,
  -- Null is open-ended, and is the normal case.
  "endsOn" DATE,

  "dayRatePence" INTEGER NOT NULL,
  "driverDayRatePence" INTEGER NOT NULL DEFAULT 0,
  "vatTreatment" "VatTreatment",

  "generateAheadDays" INTEGER NOT NULL DEFAULT 14,
  -- The cron's watermark, so running it twice in a day creates nothing the
  -- second time.
  "generatedThroughOn" DATE,

  "active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,

  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "JobContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobContract_reference_key" ON "JobContract" ("reference");
CREATE INDEX "JobContract_active_startsOn_idx" ON "JobContract" ("active", "startsOn");
CREATE INDEX "JobContract_deletedAt_idx" ON "JobContract" ("deletedAt");

ALTER TABLE "JobContract"
  ADD CONSTRAINT "JobContract_clientId_fkey" FOREIGN KEY ("clientId")
    REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "JobContract_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "JobContract_driverId_fkey" FOREIGN KEY ("driverId")
    REFERENCES "Driver" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "JobContract_vehicleId_fkey" FOREIGN KEY ("vehicleId")
    REFERENCES "Vehicle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "JobContract_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The day belongs to the contract that produced it, but stands on its own:
-- ending a contract leaves the days it already created in place.
ALTER TABLE "Job" ADD COLUMN "contractId" TEXT;

CREATE INDEX "Job_contractId_scheduledAt_idx" ON "Job" ("contractId", "scheduledAt");

ALTER TABLE "Job"
  ADD CONSTRAINT "Job_contractId_fkey" FOREIGN KEY ("contractId")
    REFERENCES "JobContract" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
