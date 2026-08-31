-- One job put to several drivers at once, first to accept takes it.
--
-- A row per driver offered rather than a list on the job, because each offer
-- is its own message in its own chat: when the job goes, the others have to
-- be edited. A driver left holding a live-looking Accept button for work
-- somebody else is already driving will tap it, and then ring the office to
-- ask why it did not work.
CREATE TABLE "JobOffer" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "messageId" INTEGER,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "JobOffer_pkey" PRIMARY KEY ("id")
);

-- One offer per driver per job. A second send would put two Accept buttons in
-- the same chat for the same work.
CREATE UNIQUE INDEX "JobOffer_jobId_driverId_key" ON "JobOffer"("jobId", "driverId");
CREATE INDEX "JobOffer_jobId_idx" ON "JobOffer"("jobId");
CREATE INDEX "JobOffer_driverId_closedAt_idx" ON "JobOffer"("driverId", "closedAt");

ALTER TABLE "JobOffer" ADD CONSTRAINT "JobOffer_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobOffer" ADD CONSTRAINT "JobOffer_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
