-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('EMAIL', 'SMS', 'BOTH', 'NONE');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "contactChannel" "ContactChannel" NOT NULL DEFAULT 'EMAIL';

-- CreateTable
CREATE TABLE "TelegramUpdate" (
    "id" TEXT NOT NULL,
    "bot" TEXT NOT NULL,
    "chatId" BIGINT,
    "kind" TEXT NOT NULL,
    "payload" TEXT,
    "driverId" TEXT,
    "userId" TEXT,
    "outcome" TEXT NOT NULL,
    "handledMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverPosition" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "jobId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracyM" INTEGER,
    "headingDeg" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramConversation" (
    "chatId" BIGINT NOT NULL,
    "step" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramConversation_pkey" PRIMARY KEY ("chatId")
);

-- CreateTable
CREATE TABLE "ClientMessage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "channel" "MessageChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "providerId" TEXT,
    "failedReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramUpdate_chatId_createdAt_idx" ON "TelegramUpdate"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramUpdate_createdAt_idx" ON "TelegramUpdate"("createdAt");

-- CreateIndex
CREATE INDEX "DriverPosition_driverId_recordedAt_idx" ON "DriverPosition"("driverId", "recordedAt");

-- CreateIndex
CREATE INDEX "DriverPosition_jobId_recordedAt_idx" ON "DriverPosition"("jobId", "recordedAt");

-- CreateIndex
CREATE INDEX "DriverPosition_recordedAt_idx" ON "DriverPosition"("recordedAt");

-- CreateIndex
CREATE INDEX "TelegramConversation_expiresAt_idx" ON "TelegramConversation"("expiresAt");

-- CreateIndex
CREATE INDEX "ClientMessage_clientId_createdAt_idx" ON "ClientMessage"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientMessage_status_idx" ON "ClientMessage"("status");

-- AddForeignKey
ALTER TABLE "DriverPosition" ADD CONSTRAINT "DriverPosition_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPosition" ADD CONSTRAINT "DriverPosition_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
