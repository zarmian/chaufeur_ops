-- Reading a job sheet: the agency's reference, the senders this install knows,
-- the labels it has learned from them, and the uploaded sheets themselves.

-- The booker's own reference for a job — an agency's reservation number.
-- Theirs, not ours: `reference` is what this system calls the job and means
-- nothing to them. Carried onto the invoice line, because it is what their
-- accounts department matches against.
ALTER TABLE "Job" ADD COLUMN "customerReference" TEXT;

CREATE TYPE "SheetPlacement" AS ENUM ('AFTER', 'BELOW', 'COLUMN', 'PARAGRAPH');
CREATE TYPE "JobSheetStatus" AS ENUM ('READ', 'BOOKED', 'DISCARDED');

-- A partner agency whose sheets this install can read. Rows, not code: each
-- install meets its own agencies, and a template per supplier would mean a
-- release every time somebody wins an account.
CREATE TABLE "SheetSender" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "accountId" TEXT,
    "clientId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SheetSender_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SheetSender_fingerprint_key" ON "SheetSender"("fingerprint");
CREATE INDEX "SheetSender_deletedAt_idx" ON "SheetSender"("deletedAt");

-- A label one sender prints, and which field sits next to it. The learning:
-- the built-in dictionary knows the wordings in general circulation, this
-- knows the ones a particular agency uses.
CREATE TABLE "SheetLabel" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "placement" "SheetPlacement" NOT NULL,
    "confirmed" INTEGER NOT NULL DEFAULT 0,
    "corrected" INTEGER NOT NULL DEFAULT 0,
    "learnedFromSheetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SheetLabel_senderId_field_label_placement_key"
    ON "SheetLabel"("senderId", "field", "label", "placement");
CREATE INDEX "SheetLabel_senderId_field_idx" ON "SheetLabel"("senderId", "field");

-- An uploaded sheet: the file, the text, and what was read out of it. The text
-- is kept so that a label taught later can be applied to sheets that already
-- failed, and so a field that turns out wrong can be checked against the page
-- as the reader saw it.
CREATE TABLE "JobSheet" (
    "id" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "senderId" TEXT,
    "text" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "jobId" TEXT,
    "status" "JobSheetStatus" NOT NULL DEFAULT 'READ',
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "JobSheet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobSheet_contentHash_idx" ON "JobSheet"("contentHash");
CREATE INDEX "JobSheet_senderId_idx" ON "JobSheet"("senderId");
CREATE INDEX "JobSheet_jobId_idx" ON "JobSheet"("jobId");
CREATE INDEX "JobSheet_deletedAt_idx" ON "JobSheet"("deletedAt");

ALTER TABLE "SheetSender" ADD CONSTRAINT "SheetSender_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SheetSender" ADD CONSTRAINT "SheetSender_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SheetSender" ADD CONSTRAINT "SheetSender_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SheetLabel" ADD CONSTRAINT "SheetLabel_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "SheetSender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobSheet" ADD CONSTRAINT "JobSheet_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "SheetSender"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobSheet" ADD CONSTRAINT "JobSheet_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobSheet" ADD CONSTRAINT "JobSheet_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
