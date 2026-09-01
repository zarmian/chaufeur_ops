-- CreateEnum
CREATE TYPE "FlightState" AS ENUM ('SCHEDULED', 'ACTIVE', 'LANDED', 'CANCELLED', 'DIVERTED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "flightAdjustedAt" TIMESTAMP(3),
ADD COLUMN     "flightPickupBaseAt" TIMESTAMP(3),
ADD COLUMN     "flightStatusId" TEXT;

-- CreateTable
CREATE TABLE "FlightStatus" (
    "id" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "scheduledOn" DATE NOT NULL,
    "state" "FlightState" NOT NULL DEFAULT 'UNKNOWN',
    "scheduledArrival" TIMESTAMP(3),
    "estimatedArrival" TIMESTAMP(3),
    "actualArrival" TIMESTAMP(3),
    "origin" TEXT,
    "destination" TEXT,
    "terminal" TEXT,
    "provider" TEXT NOT NULL,
    "raw" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlightStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlightStatus_scheduledArrival_idx" ON "FlightStatus"("scheduledArrival");

-- CreateIndex
CREATE UNIQUE INDEX "FlightStatus_flightNumber_scheduledOn_key" ON "FlightStatus"("flightNumber", "scheduledOn");

-- CreateIndex
CREATE INDEX "Job_flightStatusId_idx" ON "Job"("flightStatusId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_flightStatusId_fkey" FOREIGN KEY ("flightStatusId") REFERENCES "FlightStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
