-- The passenger's tracking link.
--
-- A second token alongside `nameBoardToken` rather than a reuse of it: the
-- board is held up by the driver, the tracking link is held by whoever booked.
-- One token would mean revoking a link forwarded to the wrong person also
-- blanks the board a driver is holding in an arrivals hall.
--
-- Nullable and issued lazily, so it stays empty on the jobs that never need
-- one. Unique because the token is the whole credential.

ALTER TABLE "Job" ADD COLUMN "trackingToken" TEXT;

CREATE UNIQUE INDEX "Job_trackingToken_key" ON "Job"("trackingToken");
