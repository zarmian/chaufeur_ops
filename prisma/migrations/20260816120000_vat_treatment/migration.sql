-- Per-line tax treatment, and the pass-through charges that never carry tax.
--
-- Every existing row keeps the behaviour it had: one rate on the invoice,
-- added on top of every line, with nothing treated as a disbursement. STANDARD
-- and 0 are exactly that, so the totals already stored still follow from the
-- lines that produced them.

CREATE TYPE "VatTreatment" AS ENUM ('STANDARD', 'INCLUSIVE', 'EXEMPT');

-- The airport barrier fee. Kept apart from PARKING because it is the other
-- charge that must never be taxed, and one called "parking" is one somebody
-- later fails to spot.
ALTER TYPE "ExpenseKind" ADD VALUE IF NOT EXISTS 'DROPOFF_CHARGE' AFTER 'PARKING';

ALTER TABLE "Client"
  ADD COLUMN "vatTreatment" "VatTreatment" NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "Account"
  ADD COLUMN "vatTreatment" "VatTreatment" NOT NULL DEFAULT 'STANDARD';

-- Nullable on the job and the hire: null means "follow whoever is billed",
-- which is different from an operator choosing STANDARD for this one job.
ALTER TABLE "Job"
  ADD COLUMN "vatTreatment" "VatTreatment";

ALTER TABLE "VehicleRental"
  ADD COLUMN "vatTreatment" "VatTreatment";

ALTER TABLE "InvoiceLine"
  ADD COLUMN "disbursementPence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "vatTreatment" "VatTreatment" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "quantity" DECIMAL(9, 2),
  ADD COLUMN "quantityUnit" TEXT,
  ADD COLUMN "unitPricePence" INTEGER;
