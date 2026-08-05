-- DropForeignKey
ALTER TABLE "DriverPayoutLine" DROP CONSTRAINT "DriverPayoutLine_jobId_fkey";

-- AlterTable
ALTER TABLE "DriverPayoutLine" ADD COLUMN     "shiftId" TEXT,
ALTER COLUMN "jobId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "rentalId" TEXT;

-- CreateIndex
CREATE INDEX "DriverPayoutLine_shiftId_idx" ON "DriverPayoutLine"("shiftId");

-- CreateIndex
CREATE INDEX "InvoiceLine_rentalId_idx" ON "InvoiceLine"("rentalId");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "VehicleRental"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPayoutLine" ADD CONSTRAINT "DriverPayoutLine_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPayoutLine" ADD CONSTRAINT "DriverPayoutLine_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "DriverShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A payout line is one thing or the other, never both and never neither.
-- Prisma's schema language cannot express this, so it is enforced here: a
-- line with no source is money owed for nothing, and a line with two would be
-- counted twice by anything that groups by either column.
ALTER TABLE "DriverPayoutLine"
  ADD CONSTRAINT "DriverPayoutLine_one_source"
  CHECK (num_nonnulls("jobId", "shiftId") = 1);

-- The same for an invoice line, which may bill a job, a rental, or neither —
-- a hand-written line for something the system does not model is legitimate.
-- What it may not do is claim to be both.
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_one_source"
  CHECK (num_nonnulls("jobId", "rentalId") <= 1);
