-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "returnOfJobId" TEXT,
ADD COLUMN     "seriesId" TEXT,
ADD COLUMN     "seriesIndex" INTEGER;

-- CreateTable
CREATE TABLE "JobSeries" (
    "id" TEXT NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "weekdays" INTEGER[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "occurrences" INTEGER,
    "endsOn" DATE,
    "label" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "JobSeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobSeries_startsAt_idx" ON "JobSeries"("startsAt");

-- CreateIndex
CREATE INDEX "JobSeries_deletedAt_idx" ON "JobSeries"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_returnOfJobId_key" ON "Job"("returnOfJobId");

-- CreateIndex
CREATE INDEX "Job_seriesId_scheduledAt_idx" ON "Job"("seriesId", "scheduledAt");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "JobSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_returnOfJobId_fkey" FOREIGN KEY ("returnOfJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSeries" ADD CONSTRAINT "JobSeries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

