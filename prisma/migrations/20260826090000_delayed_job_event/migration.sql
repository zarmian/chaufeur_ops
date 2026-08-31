-- A driver telling the office they are running late.
--
-- An event rather than a message, for the same reason wait time is computed
-- from `ARRIVED` and `POB` rather than typed: a chat message scrolls away and
-- cannot be asked "when did we know?" three weeks later, when a client is
-- disputing a late arrival. The delay a driver reported, and the moment they
-- reported it, belong on the job.
ALTER TYPE "JobEventType" ADD VALUE 'DELAYED';
