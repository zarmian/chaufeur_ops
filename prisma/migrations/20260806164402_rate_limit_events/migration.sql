-- CreateTable
CREATE TABLE "RateLimitEvent" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitEvent_bucket_subject_at_idx" ON "RateLimitEvent"("bucket", "subject", "at");

-- CreateIndex
CREATE INDEX "RateLimitEvent_at_idx" ON "RateLimitEvent"("at");

