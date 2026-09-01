-- A hire's driver is optional, and the constraint said otherwise.
--
-- `VehicleRental.driverId` is nullable in the schema — a hire can go to an
-- account or to a one-off external hirer with no driver at all — but the
-- constraint was created RESTRICT, which is what Prisma emits for a required
-- relation. Deleting a driver who had ever hired a car would have been
-- refused by the database rather than clearing the column.
--
-- Drift, not a change of intent: the schema has said `Driver?` since the
-- model was written. It surfaced when the next migration was generated and
-- is separated out here so it is not buried inside one about flights.

ALTER TABLE "VehicleRental" DROP CONSTRAINT "VehicleRental_driverId_fkey";

ALTER TABLE "VehicleRental" ADD CONSTRAINT "VehicleRental_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
