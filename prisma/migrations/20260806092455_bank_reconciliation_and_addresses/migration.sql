-- CreateEnum
CREATE TYPE "BankTxnKind" AS ENUM ('CLIENT_PAYMENT', 'DRIVER_PAYOUT', 'FUEL', 'VEHICLE_COST', 'RENTAL_INCOME', 'TRANSFER', 'UNCLASSIFIED');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "dropoffLat" DOUBLE PRECISION,
ADD COLUMN     "dropoffLng" DOUBLE PRECISION,
ADD COLUMN     "dropoffPostcode" TEXT,
ADD COLUMN     "pickupLat" DOUBLE PRECISION,
ADD COLUMN     "pickupLng" DOUBLE PRECISION,
ADD COLUMN     "pickupPostcode" TEXT;

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "layout" TEXT NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "occurredOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amountPence" INTEGER NOT NULL,
    "bankRef" TEXT,
    "balancePence" INTEGER,
    "kind" "BankTxnKind" NOT NULL DEFAULT 'UNCLASSIFIED',
    "matchedRuleId" TEXT,
    "clientId" TEXT,
    "accountId" TEXT,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "allocatedAt" TIMESTAMP(3),
    "allocatedPence" INTEGER NOT NULL DEFAULT 0,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAllocation" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "payoutId" TEXT,
    "costId" TEXT,
    "amountPence" INTEGER NOT NULL,
    "paymentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRule" (
    "id" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "kind" "BankTxnKind" NOT NULL,
    "clientId" TEXT,
    "accountId" TEXT,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BankRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnallocatedCredit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "accountId" TEXT,
    "transactionId" TEXT,
    "amountPence" INTEGER NOT NULL,
    "remainingPence" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UnallocatedCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankStatement_deletedAt_idx" ON "BankStatement"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_fingerprint_key" ON "BankTransaction"("fingerprint");

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_idx" ON "BankTransaction"("statementId");

-- CreateIndex
CREATE INDEX "BankTransaction_kind_allocatedAt_idx" ON "BankTransaction"("kind", "allocatedAt");

-- CreateIndex
CREATE INDEX "BankTransaction_occurredOn_idx" ON "BankTransaction"("occurredOn");

-- CreateIndex
CREATE INDEX "BankTransaction_deletedAt_idx" ON "BankTransaction"("deletedAt");

-- CreateIndex
CREATE INDEX "BankAllocation_transactionId_idx" ON "BankAllocation"("transactionId");

-- CreateIndex
CREATE INDEX "BankAllocation_invoiceId_idx" ON "BankAllocation"("invoiceId");

-- CreateIndex
CREATE INDEX "BankRule_active_priority_idx" ON "BankRule"("active", "priority");

-- CreateIndex
CREATE INDEX "BankRule_deletedAt_idx" ON "BankRule"("deletedAt");

-- CreateIndex
CREATE INDEX "UnallocatedCredit_clientId_idx" ON "UnallocatedCredit"("clientId");

-- CreateIndex
CREATE INDEX "UnallocatedCredit_accountId_idx" ON "UnallocatedCredit"("accountId");

-- CreateIndex
CREATE INDEX "UnallocatedCredit_deletedAt_idx" ON "UnallocatedCredit"("deletedAt");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAllocation" ADD CONSTRAINT "BankAllocation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAllocation" ADD CONSTRAINT "BankAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAllocation" ADD CONSTRAINT "BankAllocation_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "DriverPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnallocatedCredit" ADD CONSTRAINT "UnallocatedCredit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnallocatedCredit" ADD CONSTRAINT "UnallocatedCredit_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
