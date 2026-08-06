-- CreateEnum
CREATE TYPE "BulkOperationStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "BulkOperation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "BulkOperationStatus" NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "failures" TEXT[],
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkOperation_createdById_startedAt_idx" ON "BulkOperation"("createdById", "startedAt");

-- AddForeignKey
ALTER TABLE "BulkOperation" ADD CONSTRAINT "BulkOperation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

