-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramChatId" BIGINT,
ADD COLUMN     "telegramLinkedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

