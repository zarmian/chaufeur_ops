-- The meet-and-greet name board's key.
--
-- An airport transfer's driver stands in the arrivals hall holding up the
-- passenger's name. The board that shows it has to be reachable without a
-- session, because drivers have no login — they get the link on Telegram —
-- so the URL is the only thing between a passenger's name and anyone who
-- tries one.
--
-- Hence a random token per job rather than the job's own id. Issued lazily,
-- the first time a board is actually asked for, so the column stays null on
-- the overwhelming majority of jobs that will never need one. Unique so a
-- leaked link can be revoked by reissuing rather than by editing the booking.
ALTER TABLE "Job" ADD COLUMN "nameBoardToken" TEXT;

CREATE UNIQUE INDEX "Job_nameBoardToken_key" ON "Job"("nameBoardToken");
