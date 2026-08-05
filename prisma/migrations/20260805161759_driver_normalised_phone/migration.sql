-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "normalisedPhone" TEXT;

-- CreateIndex
CREATE INDEX "Driver_normalisedPhone_idx" ON "Driver"("normalisedPhone");

-- Backfill. The same folding `normalisePhone` in lib/text.ts performs:
-- strip everything but digits and a leading +, then fold +44 and 0044 to the
-- national 0 form. Without this, drivers added before the import feature
-- existed would never match a re-import and would be duplicated.
UPDATE "Driver"
SET "normalisedPhone" = CASE
  WHEN regexp_replace("phone", '[^0-9+]', '', 'g') LIKE '+44%'
    THEN '0' || substring(regexp_replace("phone", '[^0-9+]', '', 'g') from 4)
  WHEN regexp_replace("phone", '[^0-9+]', '', 'g') LIKE '0044%'
    THEN '0' || substring(regexp_replace("phone", '[^0-9+]', '', 'g') from 5)
  ELSE replace(regexp_replace("phone", '[^0-9+]', '', 'g'), '+', '')
END
WHERE "normalisedPhone" IS NULL;
