-- A user issued a temporary password must choose their own before the
-- dashboard will show them anything. Defaults false, so every existing user
-- is unaffected.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
