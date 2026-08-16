-- Hire contracts.
--
-- A rental went to a driver and only a driver. It can now go to a company
-- with an account or to somebody with neither, so driverId becomes optional
-- and is joined by accountId and a set of hirer fields for the third case.
--
-- The contract terms live on the rental because they are negotiated per hire.
-- Settings supply the defaults; what is stored here is what the signed
-- contract said, so reprinting an old one cannot restate it at today's rates.

CREATE TYPE "RenterType" AS ENUM ('DRIVER', 'ACCOUNT', 'EXTERNAL');

-- The car, as a contract has to describe it.
ALTER TABLE "Vehicle"
  ADD COLUMN "chassisNumber"     TEXT,
  ADD COLUMN "firstRegisteredOn" DATE,
  ADD COLUMN "valuePence"        INTEGER,
  ADD COLUMN "insurerName"       TEXT;

ALTER TABLE "VehicleRental"
  ADD COLUMN "renterType" "RenterType" NOT NULL DEFAULT 'DRIVER',
  ADD COLUMN "accountId"  TEXT,
  ADD COLUMN "hirerName"          TEXT,
  ADD COLUMN "hirerAddress"       TEXT,
  ADD COLUMN "hirerPhone"         TEXT,
  ADD COLUMN "hirerLicenceNumber" TEXT,
  ADD COLUMN "mileageAllowancePerDay" INTEGER,
  ADD COLUMN "excessMileagePence"     INTEGER,
  ADD COLUMN "advancePaymentPence"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimumTermDays"        INTEGER,
  ADD COLUMN "insuranceExcessPence"   INTEGER,
  ADD COLUMN "congestionChargePence"  INTEGER,
  ADD COLUMN "smokingChargePence"     INTEGER,
  ADD COLUMN "panelRepairPence"       INTEGER,
  ADD COLUMN "wheelScratchPence"      INTEGER,
  ADD COLUMN "depositReturnDays"      INTEGER,
  ADD COLUMN "ownerSignatory"         TEXT,
  ADD COLUMN "contractGeneratedAt"    TIMESTAMP(3);

-- Every existing rental went to a driver, which is what the default records.
ALTER TABLE "VehicleRental" ALTER COLUMN "driverId" DROP NOT NULL;

ALTER TABLE "VehicleRental"
  ADD CONSTRAINT "VehicleRental_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "VehicleRental_accountId_idx" ON "VehicleRental"("accountId");
