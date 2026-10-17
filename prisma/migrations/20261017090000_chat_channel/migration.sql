-- How a relayed chat message was carried: telegram, sms, or null for a
-- driver's reply, which reaches the page directly with no relay to name.
ALTER TABLE "JobChatMessage" ADD COLUMN "channel" TEXT;
