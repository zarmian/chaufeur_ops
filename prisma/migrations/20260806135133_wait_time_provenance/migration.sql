-- AlterTable
ALTER TABLE "JobFinance" ADD COLUMN     "waitAutoCalculatedAt" TIMESTAMP(3),
ADD COLUMN     "waitOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "waitOverriddenById" TEXT,
ADD COLUMN     "waitOverrideReason" TEXT;
