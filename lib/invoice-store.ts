import { Prisma } from '@prisma/client';
import { toJsonSnapshot, withAudit, type AuditContext } from './audit';
import { getBranding } from './branding-store';
import {
  canEdit,
  creditedTotalPence,
  creditNoteLines,
  formatInvoiceNumber,
  invoiceTotals,
  statusFor,
  type InvoiceStatus,
} from './invoices';
import { buildJobLine } from './invoice-lines';
import { financeAmountsFrom, jobEconomics } from './job-finance';
import { billableClientPence } from './job-status';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import type { TaxableLine, VatTreatment } from './vat';

/** Prisma hands `Decimal` back for the fractional columns; arithmetic wants a number. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  return Number((value as { toString(): string }).toString());
}

/**
 * Creating and settling invoices.
 *
 * The arithmetic and the immutability rule live in `lib/invoices.ts`. What
 * this module owns is the numbering, which is the part that has to be right
 * in a way nothing else here does: an invoice sequence with holes in it is a
 * problem at audit, and one with duplicates is worse.
 */

export type InvoiceRefusal =
  | { ok: true; id: string; number: string }
  | { ok: false; code: string; message: string };

/**
 * A lock key derived from the year.
 *
 * Postgres advisory locks take a 64-bit integer. Deriving it from the year
 * means two invoices in different years never wait on each other, and two in
 * the same year always do.
 */
function numberingLockKey(year: number): bigint {
  // An arbitrary namespace, so this cannot collide with a lock taken
  // elsewhere for something unrelated.
  return BigInt(9_100_000_000) + BigInt(year);
}

/**
 * The next number in the year's sequence, allocated inside a transaction.
 *
 * Gapless, which max-plus-one with retries is not: that pattern hands out a
 * number, tries the insert, and leaves a hole when the insert fails. Here the
 * advisory lock is held for the life of the transaction, so a concurrent
 * allocation waits rather than reading the same maximum — and if this
 * transaction rolls back, the lock is released and the number was never
 * consumed by anybody.
 *
 * Must be called inside `prisma.$transaction`. Outside one, the lock would be
 * released at the end of the statement and guarantee nothing.
 */
async function allocateNumber(
  tx: Prisma.TransactionClient,
  prefix: string,
  year: number,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${numberingLockKey(year)}::bigint)`;

  const pattern = `${prefix}-${year}-%`;
  const rows = await tx.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING("number" FROM '[0-9]+$') AS INTEGER)) AS max
    FROM "Invoice"
    WHERE "number" LIKE ${pattern}
  `;

  return formatInvoiceNumber(prefix, year, (rows[0]?.max ?? 0) + 1);
}

export interface InvoiceLineInput {
  description: string;
  amountPence: number;
  /** Pass-through charges inside `amountPence`, never taxed. */
  disbursementPence?: number | null;
  vatTreatment?: VatTreatment | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  unitPricePence?: number | null;
  jobId?: string | null;
  rentalId?: string | null;
}

/** The tax-bearing shape of a line, for the totals. */
function taxable(line: {
  amountPence: number;
  disbursementPence?: number | null;
  vatTreatment?: VatTreatment | null;
}): TaxableLine {
  return {
    amountPence: line.amountPence,
    disbursementPence: line.disbursementPence ?? 0,
    treatment: line.vatTreatment ?? 'STANDARD',
  };
}

/** The columns a line writes, with the defaults an ad-hoc line takes. */
function lineData(line: InvoiceLineInput, sortOrder: number) {
  return {
    description: line.description,
    amountPence: line.amountPence,
    disbursementPence: line.disbursementPence ?? 0,
    vatTreatment: line.vatTreatment ?? 'STANDARD',
    quantity:
      line.quantity === null || line.quantity === undefined
        ? null
        : new Prisma.Decimal(line.quantity),
    quantityUnit: line.quantityUnit ?? null,
    unitPricePence: line.unitPricePence ?? null,
    jobId: line.jobId ?? null,
    rentalId: line.rentalId ?? null,
    sortOrder,
  };
}

/**
 * Recompute an invoice's totals from its own lines.
 *
 * Called after every change rather than adjusted incrementally: tax is worked
 * out per treatment on the group's total (see `lib/vat.ts`), so adding a
 * delta would drift away from what the document says about itself.
 */
async function retotal(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  vatRatePct: number,
) {
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId },
    select: { amountPence: true, disbursementPence: true, vatTreatment: true },
  });
  const totals = invoiceTotals(lines.map(taxable), vatRatePct);

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      netPence: totals.netPence,
      vatPence: totals.vatPence,
      grossPence: totals.grossPence,
    },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
}

export interface CreateInvoiceInput {
  /** Exactly one of these. The account is the usual biller. */
  clientId?: string | null;
  accountId?: string | null;
  issueDate: Date;
  dueDate?: Date | null;
  lines: InvoiceLineInput[];
  notes?: string | null;
}

/**
 * Raise a draft invoice.
 *
 * The totals are computed here from the lines, never taken from the caller —
 * a client that could send its own total could send any total.
 */
export async function createInvoice(
  input: CreateInvoiceInput,
  context: AuditContext,
): Promise<InvoiceRefusal> {
  if (input.lines.length === 0) {
    return {
      ok: false,
      code: 'NO_LINES',
      message: 'An invoice needs at least one line.',
    };
  }

  if (!input.clientId && !input.accountId) {
    return {
      ok: false,
      code: 'NO_RECIPIENT',
      message: 'An invoice needs somebody to send it to.',
    };
  }

  // Spec 4.3.5. A job billed twice is money asked for twice, and the person
  // who spots it is the client.
  const alreadyBilled = await billedAlready(input.lines);
  if (alreadyBilled) {
    return {
      ok: false,
      code: 'ALREADY_INVOICED',
      message: alreadyBilled,
    };
  }

  const [{ invoiceNumberPrefix }, locale] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
  ]);

  const totals = invoiceTotals(input.lines.map(taxable), locale.taxRatePct);

  const dueDate = input.dueDate ?? (await defaultDueDate(input, input.issueDate));

  const created = await withAudit(
    'Invoice',
    'create',
    async (tx) => {
      const number = await allocateNumber(
        tx,
        invoiceNumberPrefix,
        input.issueDate.getUTCFullYear(),
      );

      const invoice = await tx.invoice.create({
        data: {
          number,
          clientId: input.clientId ?? null,
          accountId: input.accountId ?? null,
          issueDate: input.issueDate,
          dueDate,
          netPence: totals.netPence,
          vatPence: totals.vatPence,
          grossPence: totals.grossPence,
          vatRatePct: new Prisma.Decimal(locale.taxRatePct),
          notes: input.notes ?? null,
          lines: { create: input.lines.map(lineData) },
        },
        select: { id: true, number: true },
      });

      return { entityId: invoice.id, after: invoice, result: invoice };
    },
    context,
  );

  return { ok: true, id: created.id, number: created.number };
}

/** Whether anything on these lines is already on a live invoice. */
async function billedAlready(
  lines: InvoiceLineInput[],
): Promise<string | null> {
  const jobIds = lines.map((line) => line.jobId).filter((id): id is string => !!id);
  const rentalIds = lines
    .map((line) => line.rentalId)
    .filter((id): id is string => !!id);

  if (jobIds.length === 0 && rentalIds.length === 0) return null;

  const existing = await prisma.invoiceLine.findFirst({
    where: {
      OR: [
        ...(jobIds.length ? [{ jobId: { in: jobIds } }] : []),
        ...(rentalIds.length ? [{ rentalId: { in: rentalIds } }] : []),
      ],
      invoice: { status: { not: 'CANCELLED' } },
    },
    select: {
      jobId: true,
      rentalId: true,
      invoice: { select: { number: true } },
      job: { select: { reference: true } },
      rental: { select: { reference: true } },
    },
  });

  if (!existing) return null;

  const what =
    existing.job?.reference ?? existing.rental?.reference ?? 'That item';
  return `${what} is already on invoice ${existing.invoice.number}. Remove it from there first, or credit that invoice.`;
}

/** The recipient's payment terms decide when it is due. */
async function defaultDueDate(
  input: Pick<CreateInvoiceInput, 'clientId' | 'accountId'>,
  issueDate: Date,
): Promise<Date> {
  let days = 14;

  if (input.accountId) {
    const account = await prisma.account.findUnique({
      where: { id: input.accountId },
      select: { paymentTermsDays: true },
    });
    if (account) days = account.paymentTermsDays;
  } else if (input.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: input.clientId },
      select: { paymentTermsDays: true },
    });
    if (client) days = client.paymentTermsDays;
  }

  const due = new Date(issueDate);
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

/** Send it: the point past which it stops being editable. */
export async function markSent(
  invoiceId: string,
  context: AuditContext,
): Promise<InvoiceRefusal> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, number: true, status: true },
  });
  if (!invoice) {
    return { ok: false, code: 'NOT_FOUND', message: 'No such invoice' };
  }

  if (invoice.status !== 'DRAFT') {
    return {
      ok: false,
      code: 'ALREADY_SENT',
      message: `${invoice.number} has already been sent.`,
    };
  }

  await withAudit(
    'Invoice',
    'update',
    async (tx) => {
      const before = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      const after = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'SENT', sentAt: new Date() },
      });
      return { entityId: invoiceId, before, after, result: null };
    },
    context,
  );

  return { ok: true, id: invoice.id, number: invoice.number };
}

/**
 * Record a payment and let the status follow.
 *
 * `paidPence` accumulates and the status is recomputed rather than set, so a
 * payment entered out of order cannot leave an invoice reading `SENT` while
 * fully paid.
 */
export async function recordPayment(
  invoiceId: string,
  input: {
    amountPence: number;
    receivedAt: Date;
    gateway?: string;
    reference?: string | null;
  },
  context: AuditContext,
): Promise<InvoiceRefusal> {
  if (input.amountPence === 0) {
    return {
      ok: false,
      code: 'ZERO_PAYMENT',
      message: 'A payment of nothing is not a payment.',
    };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, number: true, status: true, grossPence: true, paidPence: true, dueDate: true },
  });
  if (!invoice) {
    return { ok: false, code: 'NOT_FOUND', message: 'No such invoice' };
  }

  if (invoice.status === 'DRAFT') {
    return {
      ok: false,
      code: 'NOT_SENT',
      message: `${invoice.number} is still a draft. Send it before recording a payment against it.`,
    };
  }

  await withAudit(
    'Invoice',
    'update',
    async (tx) => {
      const before = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

      await tx.payment.create({
        data: {
          invoiceId,
          gateway: input.gateway ?? 'manual',
          amountPence: input.amountPence,
          status: 'received',
          receivedAt: input.receivedAt,
          gatewayTxnId: input.reference ?? null,
        },
      });

      const paidPence = before.paidPence + input.amountPence;
      const after = await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          paidPence,
          status: statusFor(
            {
              status: before.status as InvoiceStatus,
              grossPence: before.grossPence,
              paidPence,
              dueDate: before.dueDate,
              creditedPence: await creditedPenceFor(tx, invoiceId),
            },
            input.receivedAt,
          ),
          paidAt: paidPence >= before.grossPence ? input.receivedAt : null,
        },
      });

      return { entityId: invoiceId, before, after, result: null };
    },
    context,
  );

  return { ok: true, id: invoice.id, number: invoice.number };
}

/**
 * Credit an invoice.
 *
 * A separate document referencing the original, not an edit — spec 4.3.11.
 * The original keeps its number and its total; what changes is that there is
 * now a second document saying it was reversed.
 */
/**
 * What credit notes against this invoice come to, from inside a transaction.
 *
 * Every place that writes a status needs it. A credit note is what settles the
 * invoice it reverses, so a `statusFor` call that cannot see one writes
 * `OVERDUE` straight back over `CREDITED` the next time a payment lands — and
 * the invoice returns to the chasing list owing nothing.
 */
/**
 * The sliver of a client this needs: anything that can read invoices.
 *
 * Structural rather than `Prisma.TransactionClient` because the callers are
 * split — `withAudit` hands back a plain transaction client, and
 * reconciliation's undo path runs on the extended one. Both can do this much.
 */
export interface CreditNoteReader {
  invoice: {
    findMany(args: {
      where: { creditsInvoiceId: string };
      select: { grossPence: true };
    }): Promise<Array<{ grossPence: number }>>;
  };
}

export async function creditedPenceFor(
  tx: CreditNoteReader,
  invoiceId: string,
): Promise<number> {
  const notes = await tx.invoice.findMany({
    where: { creditsInvoiceId: invoiceId },
    select: { grossPence: true },
  });
  return creditedTotalPence(notes);
}

/**
 * Settle the invoice a credit note reverses, in the same transaction.
 *
 * Raising the note was only ever half of it. The document existed and nothing
 * read it: the original stayed `SENT`, the ledger's `Credited` filter was
 * permanently empty, and a fully credited invoice went on being chased as
 * overdue for money that had already been given back. `SETTLED` has contained
 * `CREDITED` all along — nothing ever wrote it.
 *
 * Audited separately because a second entity changed here: `withAudit` records
 * the credit note, and this is the invoice.
 */
async function settleCreditedInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  at: Date,
  context: AuditContext,
): Promise<void> {
  const before = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

  const status = statusFor(
    {
      status: before.status as InvoiceStatus,
      grossPence: before.grossPence,
      paidPence: before.paidPence,
      dueDate: before.dueDate,
      creditedPence: await creditedPenceFor(tx, invoiceId),
    },
    at,
  );

  // A partial credit leaves a balance, and an invoice that still owes
  // something is still owed — leave it where it is.
  if (status === before.status) return;

  const after = await tx.invoice.update({ where: { id: invoiceId }, data: { status } });

  await tx.auditLog.create({
    data: {
      entity: 'Invoice',
      entityId: invoiceId,
      action: 'update',
      userId: context.userId ?? null,
      ip: context.ip ?? null,
      before: toJsonSnapshot(before),
      after: toJsonSnapshot(after),
    },
  });
}

export async function createCreditNote(
  invoiceId: string,
  context: AuditContext,
): Promise<InvoiceRefusal> {
  const original = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      number: true,
      status: true,
      clientId: true,
      accountId: true,
      // The rate the original was raised at. A credit note that reverses a
      // 20% invoice at today's 17.5% hands back the wrong money.
      vatRatePct: true,
      lines: {
        select: {
          description: true,
          amountPence: true,
          disbursementPence: true,
          vatTreatment: true,
          quantity: true,
          quantityUnit: true,
          unitPricePence: true,
          jobId: true,
          rentalId: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!original) {
    return { ok: false, code: 'NOT_FOUND', message: 'No such invoice' };
  }

  if (original.status === 'DRAFT') {
    return {
      ok: false,
      code: 'STILL_DRAFT',
      message: `${original.number} has not been sent, so it can simply be edited or cancelled — a credit note would be a document reversing one nobody has.`,
    };
  }

  const [{ invoiceNumberPrefix }] = await Promise.all([getBranding()]);

  // The original's rate, not today's. A credit note settles a specific
  // invoice, and one raised at a rate that has since changed would leave a
  // balance that no payment can clear.
  const vatRatePct = Number(original.vatRatePct);
  const lines = creditNoteLines(original.lines);
  const totals = invoiceTotals(lines.map(taxable), vatRatePct);
  const issueDate = new Date();

  const created = await withAudit(
    'Invoice',
    'create',
    async (tx) => {
      const number = await allocateNumber(
        tx,
        invoiceNumberPrefix,
        issueDate.getUTCFullYear(),
      );

      const note = await tx.invoice.create({
        data: {
          number,
          clientId: original.clientId,
          accountId: original.accountId,
          issueDate,
          dueDate: issueDate,
          netPence: totals.netPence,
          vatPence: totals.vatPence,
          grossPence: totals.grossPence,
          vatRatePct: new Prisma.Decimal(vatRatePct),
          status: 'SENT',
          sentAt: issueDate,
          creditsInvoiceId: original.id,
          notes: `Credit note for ${original.number}`,
          lines: {
            // The link back to the job or rental is kept, along with the
            // treatment and the quantity columns: a credit note that is
            // untraceable free text means nothing reconciles.
            create: lines.map((line, index) =>
              lineData(
                { ...line, quantity: toNumberOrNull(line.quantity) },
                index,
              ),
            ),
          },
        },
        select: { id: true, number: true },
      });

      // After the note exists, so it counts towards what has been credited.
      await settleCreditedInvoice(tx, original.id, issueDate, context);

      return { entityId: note.id, after: note, result: note };
    },
    context,
  );

  return { ok: true, id: created.id, number: created.number };
}

/**
 * Line editing while the invoice is still a draft — spec 4.3.7.
 *
 * Description, amount, order, and ad-hoc lines tied to no job at all: a
 * waiting charge agreed on the phone, a goodwill discount, a parking fee
 * somebody forgot to itemise. Without them an operator either sends an
 * invoice that is wrong or does the whole thing in a spreadsheet.
 *
 * Every one of these recomputes the totals rather than adjusting them. VAT is
 * charged on the total, not per line (see `invoiceTotals`), so an incremental
 * adjustment would drift away from what the invoice says about itself.
 */
export interface LineFields {
  description: string;
  amountPence: number;
  /**
   * The pass-through part. Editable because the operator is the one who knows
   * that £7.50 of a £97.50 line was the car park — see `lib/vat.ts`.
   */
  disbursementPence?: number | null;
  vatTreatment?: VatTreatment | null;
}

export type LineEdit =
  | ({ kind: 'add' } & LineFields)
  | ({ kind: 'update'; lineId: string } & LineFields)
  | { kind: 'remove'; lineId: string }
  | { kind: 'move'; lineId: string; direction: 'up' | 'down' };

export async function editLines(
  invoiceId: string,
  edit: LineEdit,
  context: AuditContext,
): Promise<InvoiceRefusal> {
  const editable = await assertEditable(invoiceId);
  if (!editable.ok) return editable;

  if (edit.kind === 'add' || edit.kind === 'update') {
    if (!edit.description.trim()) {
      return {
        ok: false,
        code: 'NO_DESCRIPTION',
        message: 'A line needs a description — the recipient has to know what they are paying for.',
      };
    }
  }

  await withAudit(
    'Invoice',
    'update',
    async (tx) => {
      const before = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      });

      if (edit.kind === 'add') {
        await tx.invoiceLine.create({
          data: {
            invoiceId,
            ...lineData(
              { ...edit, description: edit.description.trim() },
              before.lines.length,
            ),
          },
        });
      } else if (edit.kind === 'update') {
        await tx.invoiceLine.updateMany({
          where: { id: edit.lineId, invoiceId },
          data: {
            description: edit.description.trim(),
            amountPence: edit.amountPence,
            disbursementPence: edit.disbursementPence ?? 0,
            vatTreatment: edit.vatTreatment ?? 'STANDARD',
          },
        });
      } else if (edit.kind === 'remove') {
        await tx.invoiceLine.deleteMany({ where: { id: edit.lineId, invoiceId } });
      } else {
        // Swap sort orders with the neighbour, then renumber below so a
        // sequence that has had lines removed cannot end up with two rows
        // sharing a position and ordering arbitrarily.
        const index = before.lines.findIndex((line) => line.id === edit.lineId);
        const target = edit.direction === 'up' ? index - 1 : index + 1;
        if (index >= 0 && target >= 0 && target < before.lines.length) {
          const ordered = [...before.lines];
          const moved = ordered[index]!;
          ordered[index] = ordered[target]!;
          ordered[target] = moved;
          for (const [position, line] of ordered.entries()) {
            await tx.invoiceLine.update({
              where: { id: line.id },
              data: { sortOrder: position },
            });
          }
        }
      }

      const after = await retotal(tx, invoiceId, Number(before.vatRatePct));

      return { entityId: invoiceId, before, after, result: null };
    },
    context,
  );

  return editable;
}

/**
 * Put one job on a draft invoice — spec 6.5.2.
 *
 * A job-aware `add`, not the free-text one. A line created through `editLines`
 * carries no `jobId`, so the job would still count as unbilled and could be
 * invoiced a second time — which is money asked for twice, and the person who
 * spots it is the client.
 *
 * Refuses rather than guesses on an unpriced job. Adding it as a zero line
 * would put a £0 row in front of a client and quietly mark the job billed,
 * which is exactly how the legacy system lost 140 fares.
 */
export async function addJobLine(
  invoiceId: string,
  jobId: string,
  context: AuditContext,
): Promise<InvoiceRefusal> {
  const editable = await assertEditable(invoiceId);
  if (!editable.ok) return editable;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      jobType: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      viaText: true,
      passengerName: true,
      flightNumber: true,
      clientPricePence: true,
      // The hourly total, for an as-directed job. Without it this refused
      // every as-directed job as "no client price" and, worse, would have
      // billed one at zero if it had let it through.
      finance: true,
      // Stop charges and recharged expenses are revenue the finance panel
      // never saw — see `jobEconomics`. `kind` additionally says which of the
      // recharged ones are pass-through.
      stops: { select: { chargePence: true } },
      expenses: { select: { kind: true, amountPence: true, borneBy: true } },
      driverPricePence: true,
      shiftId: true,
      vatTreatment: true,
      account: { select: { vatTreatment: true } },
      client: { select: { vatTreatment: true } },
      zeroValueReason: true,
      status: true,
      invoiceLines: { select: { invoice: { select: { number: true } } } },
    },
  });

  if (!job) {
    return { ok: false, code: 'NOT_FOUND', message: 'That job no longer exists.' };
  }

  const billed = job.invoiceLines[0]?.invoice.number;
  if (billed) {
    return {
      ok: false,
      code: 'ALREADY_INVOICED',
      message: `${job.reference} is already on ${billed}.`,
    };
  }

  // Everything the client owes for this job: the fare or hours × rate, plus
  // stop charges and any expense recharged to them. The same function the
  // "new invoice" picker prices with — the two used to disagree, and this
  // path silently dropped a job's recharged parking, so it was never billed
  // by anybody.
  const finance = financeAmountsFrom(job.finance);
  const amountPence = jobEconomics({
    finance,
    clientPricePence: job.clientPricePence,
    driverPricePence: job.driverPricePence,
    stops: job.stops,
    expenses: job.expenses,
    paidByShift: Boolean(job.shiftId),
  }).totalClientPence;

  // Guarded on the fare, not the total: a job with no price but £7.50 of
  // recharged parking is still an unpriced job, and letting it through would
  // mark it billed for the car park alone.
  if (billableClientPence(job) <= 0 && !job.zeroValueReason) {
    return {
      ok: false,
      code: 'NO_PRICE',
      message: `${job.reference} has no client price — price it before invoicing it.`,
    };
  }

  await withAudit(
    'Invoice',
    'update',
    async (tx) => {
      const before = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      });

      await tx.invoiceLine.create({
        data: {
          invoiceId,
          ...lineData(
            { ...buildJobLine({ job: { ...job, finance }, amountPence }), jobId: job.id },
            before.lines.length,
          ),
        },
      });

      const after = await retotal(tx, invoiceId, Number(before.vatRatePct));

      return { entityId: invoiceId, before, after, result: null };
    },
    context,
  );

  // `editable` already carries the invoice's id and number, which is what a
  // caller wants back — the same shape `editLines` returns.
  return editable;
}

/** Editing a line, refused once the invoice has left the building. */
export async function assertEditable(invoiceId: string): Promise<InvoiceRefusal> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, number: true, status: true },
  });
  if (!invoice) {
    return { ok: false, code: 'NOT_FOUND', message: 'No such invoice' };
  }

  const editable = canEdit({ status: invoice.status as InvoiceStatus });
  if (!editable.ok) {
    return { ok: false, code: editable.code, message: editable.message };
  }

  return { ok: true, id: invoice.id, number: invoice.number };
}

/**
 * Move anything past its due date to `OVERDUE`.
 *
 * Run from the cron. Status is otherwise only recalculated when something
 * happens to an invoice, and nothing happens to one that is simply being
 * ignored — which is exactly the one worth flagging.
 */
export async function refreshOverdue(now: Date = new Date()): Promise<number> {
  const result = await prisma.invoice.updateMany({
    where: {
      status: { in: ['SENT', 'PART_PAID'] },
      dueDate: { lt: now },
      // Nothing left to collect is not overdue. A fully credited invoice
      // reached `CREDITED` and is excluded by the status filter above, but an
      // invoice credited in full while still `SENT` would otherwise be swept
      // into `OVERDUE` before anything recomputed its status.
      NOT: { creditNotes: { some: {} } },
    },
    data: { status: 'OVERDUE' },
  });
  return result.count;
}
