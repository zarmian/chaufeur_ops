-- What a job sheet's two addresses resolved to, once looked up.
--
-- Beside the draft rather than inside it: the draft is what the page says,
-- this is what a Places provider made of it, and an operator checking a
-- pre-filled form against the sheet has to be able to see both.
ALTER TABLE "JobSheet" ADD COLUMN "located" JSONB;
