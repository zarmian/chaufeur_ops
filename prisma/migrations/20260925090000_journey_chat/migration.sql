-- Passenger <-> driver messages, relayed through the bot.
CREATE TYPE "ChatAuthor" AS ENUM ('PASSENGER', 'DRIVER');

CREATE TABLE "JobChatMessage" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "author" "ChatAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobChatMessage_jobId_createdAt_idx" ON "JobChatMessage"("jobId", "createdAt");

ALTER TABLE "JobChatMessage" ADD CONSTRAINT "JobChatMessage_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
