-- CreateEnum
CREATE TYPE "VehicleOwnership" AS ENUM ('OWNED', 'FINANCED', 'LEASED', 'DRIVER_OWNED');

-- CreateEnum
CREATE TYPE "VehicleCostKind" AS ENUM ('SERVICE', 'REPAIR', 'MOT_TEST', 'TYRES', 'BODYWORK', 'CLEANING', 'INSURANCE', 'ROAD_TAX', 'FINANCE', 'LEASE', 'BREAKDOWN_COVER', 'PARKING_PERMIT', 'OTHER');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "acquiredOn" DATE,
ADD COLUMN     "currentOdometer" INTEGER,
ADD COLUMN     "disposedOn" DATE,
ADD COLUMN     "lastServiceMiles" INTEGER,
ADD COLUMN     "lastServicedOn" DATE,
ADD COLUMN     "ownerDriverId" TEXT,
ADD COLUMN     "ownership" "VehicleOwnership" NOT NULL DEFAULT 'DRIVER_OWNED',
ADD COLUMN     "purchasePricePence" INTEGER,
ADD COLUMN     "serviceEveryMiles" INTEGER,
ADD COLUMN     "serviceEveryMonths" INTEGER;

-- CreateTable
CREATE TABLE "VehicleCost" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "kind" "VehicleCostKind" NOT NULL,
    "amountPence" INTEGER NOT NULL,
    "incurredOn" DATE NOT NULL,
    "supplier" TEXT,
    "invoiceRef" TEXT,
    "odometer" INTEGER,
    "receiptFileKey" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VehicleCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleStandingCost" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "kind" "VehicleCostKind" NOT NULL,
    "label" TEXT NOT NULL,
    "amountPence" INTEGER NOT NULL,
    "periodMonths" INTEGER NOT NULL DEFAULT 1,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VehicleStandingCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleCost_vehicleId_incurredOn_idx" ON "VehicleCost"("vehicleId", "incurredOn");

-- CreateIndex
CREATE INDEX "VehicleCost_kind_idx" ON "VehicleCost"("kind");

-- CreateIndex
CREATE INDEX "VehicleCost_deletedAt_idx" ON "VehicleCost"("deletedAt");

-- CreateIndex
CREATE INDEX "VehicleStandingCost_vehicleId_startsOn_idx" ON "VehicleStandingCost"("vehicleId", "startsOn");

-- CreateIndex
CREATE INDEX "VehicleStandingCost_deletedAt_idx" ON "VehicleStandingCost"("deletedAt");

-- CreateIndex
CREATE INDEX "Vehicle_ownership_idx" ON "Vehicle"("ownership");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_ownerDriverId_fkey" FOREIGN KEY ("ownerDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleCost" ADD CONSTRAINT "VehicleCost_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleStandingCost" ADD CONSTRAINT "VehicleStandingCost_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
