-- Contract hire: a car and driver held for a block of days at a day rate.
--
-- Modelled alongside the hourly pair rather than reusing it. `customerHours`
-- carries a free-wait allowance and a minimum-hours rule; a day rate that
-- inherited either would be wrong in a way nobody would spot on the invoice.
--
-- Every existing row is unaffected: no job is a CONTRACT, no finance row has
-- days, and a rule with no day rate prices exactly as it did.

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'CONTRACT';

-- The last instant the block covers, in the configured timezone. Null on
-- every other type, where an estimate is what says when the job ends.
ALTER TABLE "Job"
  ADD COLUMN "contractEndsAt" TIMESTAMP(3);

ALTER TABLE "JobFinance"
  ADD COLUMN "customerDays" DECIMAL(6, 2),
  ADD COLUMN "customerDayRatePence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "driverDays" DECIMAL(6, 2),
  ADD COLUMN "driverDayRatePence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "RateCardRule"
  ADD COLUMN "perDayPence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimumDays" DECIMAL(5, 2);

-- A contract is found by the days it spans, not only by the day it starts:
-- the dispatch board asks "what covers today", and a five-day booking that
-- began on Monday has to answer on Thursday.
CREATE INDEX "Job_contractEndsAt_idx" ON "Job" ("contractEndsAt");
