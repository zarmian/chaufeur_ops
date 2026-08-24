-- Staff binding their own Telegram to the admin bot — spec 5.9.1.
--
-- `User.telegramChatId` has existed since the admin bot was built, and
-- `userForChat` has been reading it the whole time. Nothing ever wrote it:
-- the bot told an unlinked staff member to "ask an administrator to link it"
-- and there was no screen on which any administrator could. This is the
-- missing half.
--
-- A table of its own rather than a nullable `driverId` on `LinkToken`. The
-- two bind different things to different bots, and one table able to hold
-- either is one missing `where` away from redeeming a driver's link against a
-- staff account — which would hand a driver the commands that show revenue.
CREATE TABLE "StaffLinkToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLinkToken_pkey" PRIMARY KEY ("id")
);

-- Unique because the token is the whole credential: it is looked up by
-- nothing else, and a duplicate would make "which account does this link
-- bind?" ambiguous at the moment it is redeemed.
CREATE UNIQUE INDEX "StaffLinkToken_token_key" ON "StaffLinkToken"("token");

CREATE INDEX "StaffLinkToken_userId_idx" ON "StaffLinkToken"("userId");

ALTER TABLE "StaffLinkToken" ADD CONSTRAINT "StaffLinkToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
