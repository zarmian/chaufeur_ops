-- When the client was sent this job's tracking link. Null until it goes, which
-- is what stops the cron sending it twice.
ALTER TABLE "Job" ADD COLUMN "journeyLinkSentAt" TIMESTAMP(3);
