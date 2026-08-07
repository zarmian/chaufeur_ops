-- Settle invoices that were credited before anything wrote the status.
--
-- `createCreditNote` raised the note and left the invoice it reversed alone,
-- so on every install that used credit notes before this release those
-- invoices are still SENT, still absent from the ledger's Credited filter,
-- and still in the overdue list being chased for money that was given back.
-- The code fix only settles invoices credited from now on; these are the ones
-- already on the books.
--
-- The condition is `statusFor`, in SQL: fully covered by credits, with a real
-- value, and not actually paid — a paid invoice is PAID and outranks this.
-- Credit notes carry negative gross, hence the negation. DRAFT and CANCELLED
-- are decisions rather than consequences and are left alone, as is anything
-- partly credited, which still owes the balance.
UPDATE "Invoice" AS i
SET "status" = 'CREDITED'
WHERE i."status" IN ('SENT', 'PART_PAID', 'OVERDUE')
  AND i."deletedAt" IS NULL
  AND i."grossPence" > 0
  AND i."paidPence" < i."grossPence"
  AND i."grossPence" - i."paidPence" - COALESCE(
        (
          SELECT SUM(-c."grossPence")
          FROM "Invoice" c
          WHERE c."creditsInvoiceId" = i."id"
            AND c."deletedAt" IS NULL
        ),
        0
      ) <= 0;
