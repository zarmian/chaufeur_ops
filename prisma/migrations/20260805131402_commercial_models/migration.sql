-- CreateEnum
CREATE TYPE "EngagementKind" AS ENUM ('OWNER_DRIVER', 'HIRED');

-- CreateEnum
CREATE TYPE "ExpenseBearer" AS ENUM ('CLIENT', 'COMPANY', 'DRIVER');

-- CreateEnum
CREATE TYPE "RentalRateType" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "RentalStatus" AS ENUM ('BOOKED', 'ACTIVE', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HandoverPhase" AS ENUM ('OUT', 'IN');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "engagementKind" "EngagementKind",
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "JobExpense" ADD COLUMN     "borneBy" "ExpenseBearer" NOT NULL DEFAULT 'COMPANY';

-- CreateTable
CREATE TABLE "DriverEngagement" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "kind" "EngagementKind" NOT NULL DEFAULT 'OWNER_DRIVER',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "hourlyRatePence" INTEGER,
    "dayRatePence" INTEGER,
    "overtimeAfterMin" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DriverEngagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverShift" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "hourlyRatePence" INTEGER NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DriverShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStop" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "locationId" TEXT,
    "arrivedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "waitMinutes" INTEGER,
    "chargePence" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "JobStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleRental" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "rateType" "RentalRateType" NOT NULL DEFAULT 'DAILY',
    "ratePence" INTEGER NOT NULL,
    "depositPence" INTEGER NOT NULL DEFAULT 0,
    "depositReturnedPence" INTEGER NOT NULL DEFAULT 0,
    "depositReturnedAt" TIMESTAMP(3),
    "mileageOut" INTEGER,
    "mileageIn" INTEGER,
    "fuelOutPct" INTEGER,
    "fuelInPct" INTEGER,
    "damageNotes" TEXT,
    "damageChargePence" INTEGER NOT NULL DEFAULT 0,
    "status" "RentalStatus" NOT NULL DEFAULT 'BOOKED',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VehicleRental_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalPayment" (
    "id" TEXT NOT NULL,
    "rentalId" TEXT NOT NULL,
    "amountPence" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" "PayMethod",
    "reference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RentalPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalChecklistItem" (
    "id" TEXT NOT NULL,
    "rentalId" TEXT NOT NULL,
    "phase" "HandoverPhase" NOT NULL,
    "label" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverEngagement_driverId_effectiveFrom_idx" ON "DriverEngagement"("driverId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "DriverEngagement_deletedAt_idx" ON "DriverEngagement"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriverShift_reference_key" ON "DriverShift"("reference");

-- CreateIndex
CREATE INDEX "DriverShift_driverId_startedAt_idx" ON "DriverShift"("driverId", "startedAt");

-- CreateIndex
CREATE INDEX "DriverShift_endedAt_idx" ON "DriverShift"("endedAt");

-- CreateIndex
CREATE INDEX "DriverShift_deletedAt_idx" ON "DriverShift"("deletedAt");

-- CreateIndex
CREATE INDEX "JobStop_jobId_idx" ON "JobStop"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobStop_jobId_sequence_key" ON "JobStop"("jobId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleRental_reference_key" ON "VehicleRental"("reference");

-- CreateIndex
CREATE INDEX "VehicleRental_vehicleId_startAt_idx" ON "VehicleRental"("vehicleId", "startAt");

-- CreateIndex
CREATE INDEX "VehicleRental_driverId_idx" ON "VehicleRental"("driverId");

-- CreateIndex
CREATE INDEX "VehicleRental_status_idx" ON "VehicleRental"("status");

-- CreateIndex
CREATE INDEX "VehicleRental_deletedAt_idx" ON "VehicleRental"("deletedAt");

-- CreateIndex
CREATE INDEX "RentalPayment_rentalId_idx" ON "RentalPayment"("rentalId");

-- CreateIndex
CREATE INDEX "RentalChecklistItem_rentalId_phase_idx" ON "RentalChecklistItem"("rentalId", "phase");

-- CreateIndex
CREATE INDEX "Job_shiftId_idx" ON "Job"("shiftId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "DriverShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverEngagement" ADD CONSTRAINT "DriverEngagement_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStop" ADD CONSTRAINT "JobStop_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStop" ADD CONSTRAINT "JobStop_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRental" ADD CONSTRAINT "VehicleRental_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRental" ADD CONSTRAINT "VehicleRental_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRental" ADD CONSTRAINT "VehicleRental_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalPayment" ADD CONSTRAINT "RentalPayment_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "VehicleRental"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalChecklistItem" ADD CONSTRAINT "RentalChecklistItem_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "VehicleRental"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
