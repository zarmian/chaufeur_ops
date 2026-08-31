import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertEditable,
  createCreditNote,
  createInvoice,
  editLines,
  markSent,
  recordPayment,
  refreshOverdue,
} from './invoice-store';
import { parseInvoiceNumber } from './invoices';

/**
 * Invoicing against a real database.
 *
 * The arithmetic is unit-tested. What only this can prove is the numbering:
 * a sequence with holes is a problem at audit and one with duplicates is
 * worse, and neither shows up in a test that raises invoices one at a time.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-6);

/** A year of its own, so these tests never collide with seeded invoices. */
const YEAR = 2117;
const ISSUE = new Date(`${YEAR}-03-01T00:00:00Z`);

describe.skipIf(!DATABASE_AVAILABLE)('invoicing', () => {
  let accountId = '';
  const invoiceIds: string[] = [];

  async function cleanup() {
    if (!raw) return;
    const ours = await raw.invoice.findMany({
      where: { number: { contains: `-${YEAR}-` } },
      select: { id: true },
    });
    const ids = [...new Set([...invoiceIds, ...ours.map((i) => i.id)])];
    if (ids.length > 0) {
      await raw.payment.deleteMany({ where: { invoiceId: { in: ids } } });
      await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: ids } } });
      await raw.invoice.deleteMany({ where: { id: { in: ids } } });
    }
  }

  beforeAll(async () => {
    if (!raw) return;
    await cleanup();
    const account = await raw.account.create({
      data: { name: `Invoice Account ${stamp}`, kind: 'AGENCY', paymentTermsDays: 30 },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await cleanup();
    await raw.account.deleteMany({ where: { id: accountId } });
    await raw.$disconnect();
  });

  async function raise(amountPence = 10000, description = 'Consultancy') {
    const result = await createInvoice(
      { accountId, issueDate: ISSUE, lines: [{ description, amountPence }] },
      audit,
    );
    if (result.ok) invoiceIds.push(result.id);
    return result;
  }

  it('numbers the first invoice of the year at one', async () => {
    const result = await raise();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseInvoiceNumber(result.number, result.number.split('-')[0]!);
    expect(parsed?.year).toBe(YEAR);
    expect(parsed?.sequence).toBe(1);
  });

  it('computes the totals itself rather than trusting a caller', async () => {
    const result = await raise(12500);
    if (!result.ok) return;

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(invoice.netPence).toBe(12500);
    expect(invoice.vatPence).toBe(2500);
    expect(invoice.grossPence).toBe(15000);
  });

  it("takes the due date from the recipient's payment terms", async () => {
    // The account is on 30 days.
    const result = await raise();
    if (!result.ok) return;

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
    });
    const days = Math.round(
      (invoice.dueDate.getTime() - invoice.issueDate.getTime()) / 86_400_000,
    );
    expect(days).toBe(30);
  });

  it('allocates a gapless sequence under concurrency', async () => {
    // The case the advisory lock exists for. Max-plus-one with retries hands
    // out a number, tries the insert, and leaves a hole when it fails —
    // and under load it hands the same number to two writers.
    const before = await highestSequence();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        raise(1000 + index, `Concurrent ${index}`),
      ),
    );

    const numbers = results
      .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
      .map((result) => result.number);

    expect(numbers).toHaveLength(10);
    expect(new Set(numbers).size).toBe(10);

    const sequences = numbers
      .map((number) => parseInvoiceNumber(number, number.split('-')[0]!)!.sequence)
      .sort((a, b) => a - b);

    // Consecutive, with no holes and no repeats.
    expect(sequences[0]).toBe(before + 1);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBe(sequences[index - 1]! + 1);
    }
  });

  it('leaves no hole when an invoice fails to be created', async () => {
    // A number consumed by a rolled-back transaction is a gap at audit.
    const before = await highestSequence();

    const refused = await createInvoice(
      { accountId, issueDate: ISSUE, lines: [] },
      audit,
    );
    expect(refused.ok).toBe(false);

    const next = await raise();
    if (!next.ok) return;
    const parsed = parseInvoiceNumber(next.number, next.number.split('-')[0]!);
    expect(parsed?.sequence).toBe(before + 1);
  });

  it('refuses an invoice with no recipient', async () => {
    const result = await createInvoice(
      { issueDate: ISSUE, lines: [{ description: 'x', amountPence: 100 }] },
      audit,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_RECIPIENT');
  });

  it('refuses to bill the same job twice, and names where it already is', async () => {
    // Spec 4.3.5. The person who spots a double charge is the client.
    const job = await raw!.job.create({
      data: {
        reference: `IJ${stamp}`,
        jobType: 'TRANSFER',
        status: 'COMPLETED',
        scheduledAt: ISSUE,
        pickupText: 'A',
        dropoffText: 'B',
        clientPricePence: 20000,
      },
    });

    const first = await createInvoice(
      {
        accountId,
        issueDate: ISSUE,
        lines: [{ description: 'Job', amountPence: 20000, jobId: job.id }],
      },
      audit,
    );
    expect(first.ok).toBe(true);
    if (first.ok) invoiceIds.push(first.id);

    const second = await createInvoice(
      {
        accountId,
        issueDate: ISSUE,
        lines: [{ description: 'Job again', amountPence: 20000, jobId: job.id }],
      },
      audit,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('ALREADY_INVOICED');
      expect(second.message).toContain(`IJ${stamp}`);
      expect(second.message).toContain(first.ok ? first.number : '');
    }

    await raw!.invoiceLine.deleteMany({ where: { jobId: job.id } });
    await raw!.job.delete({ where: { id: job.id } });
  });

  it('locks an invoice once sent, and points at the credit note', async () => {
    const result = await raise(30000);
    if (!result.ok) return;

    expect((await assertEditable(result.id)).ok).toBe(true);

    await markSent(result.id, audit);

    const refusal = await assertEditable(result.id);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.code).toBe('INVOICE_LOCKED');
      expect(refusal.message).toMatch(/credit note/);
    }
  });

  it('accumulates payments and lets the status follow', async () => {
    const result = await raise(20000);
    if (!result.ok) return;
    await markSent(result.id, audit);

    await recordPayment(
      result.id,
      { amountPence: 10000, receivedAt: ISSUE },
      audit,
    );
    let invoice = await raw!.invoice.findUniqueOrThrow({ where: { id: result.id } });
    expect(invoice.paidPence).toBe(10000);
    expect(invoice.status).toBe('PART_PAID');

    // 20000 net plus 20% VAT is 24000 gross.
    await recordPayment(
      result.id,
      { amountPence: 14000, receivedAt: ISSUE },
      audit,
    );
    invoice = await raw!.invoice.findUniqueOrThrow({ where: { id: result.id } });
    expect(invoice.paidPence).toBe(24000);
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).not.toBeNull();
  });

  it('refuses a payment against a draft', async () => {
    // Paying an invoice nobody has been sent is a bookkeeping error.
    const result = await raise();
    if (!result.ok) return;

    const refusal = await recordPayment(
      result.id,
      { amountPence: 100, receivedAt: ISSUE },
      audit,
    );
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.code).toBe('NOT_SENT');
  });

  it('credits a sent invoice with a negative one that references it', async () => {
    const result = await raise(15000, 'Job JOB-000001');
    if (!result.ok) return;
    await markSent(result.id, audit);

    const note = await createCreditNote(result.id, audit);
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    invoiceIds.push(note.id);

    const credit = await raw!.invoice.findUniqueOrThrow({
      where: { id: note.id },
      include: { lines: true },
    });

    expect(credit.creditsInvoiceId).toBe(result.id);
    expect(credit.netPence).toBe(-15000);
    expect(credit.grossPence).toBe(-18000);
    expect(credit.lines[0]?.amountPence).toBe(-15000);

    // The original is untouched: it keeps its number and its total.
    const original = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(original.netPence).toBe(15000);
  });

  it('refuses a credit note against a draft, and says why', async () => {
    // A document reversing one nobody has.
    const result = await raise();
    if (!result.ok) return;

    const note = await createCreditNote(result.id, audit);
    expect(note.ok).toBe(false);
    if (!note.ok) expect(note.code).toBe('STILL_DRAFT');
  });

  it('adds an ad-hoc line to a draft and recomputes the totals', async () => {
    // Spec 4.3.7. A waiting charge agreed on the phone, a parking fee nobody
    // itemised — without ad-hoc lines the operator sends a wrong invoice or
    // does the whole thing in a spreadsheet.
    const result = await raise(10_000);
    if (!result.ok) return;

    const edit = await editLines(
      result.id,
      { kind: 'add', description: 'Parking at the terminal', amountPence: 1250 },
      audit,
    );
    expect(edit.ok).toBe(true);

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
      include: { lines: true },
    });
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.netPence).toBe(11_250);
    expect(invoice.vatPence).toBe(2250);
    expect(invoice.grossPence).toBe(13_500);
  });

  it('recomputes rather than adjusts, so VAT stays charged on the total', async () => {
    // Twenty lines of £10.99 at 20% round to £2.20 each — £44.00 — where the
    // correct figure on £219.80 is £43.96. An incremental adjustment would
    // drift into the first number; a recompute cannot.
    const result = await createInvoice(
      {
        accountId,
        issueDate: ISSUE,
        lines: Array.from({ length: 19 }, () => ({
          description: 'A run',
          amountPence: 1099,
        })),
      },
      audit,
    );
    if (!result.ok) return;
    invoiceIds.push(result.id);

    await editLines(
      result.id,
      { kind: 'add', description: 'A run', amountPence: 1099 },
      audit,
    );

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(invoice.netPence).toBe(21_980);
    expect(invoice.vatPence).toBe(4396);
  });

  it('edits, reorders and removes a draft line', async () => {
    const result = await raise(10_000, 'First');
    if (!result.ok) return;

    await editLines(
      result.id,
      { kind: 'add', description: 'Second', amountPence: 2000 },
      audit,
    );

    const before = await raw!.invoiceLine.findMany({
      where: { invoiceId: result.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(before.map((line) => line.description)).toEqual(['First', 'Second']);

    await editLines(
      result.id,
      { kind: 'move', lineId: before[1]!.id, direction: 'up' },
      audit,
    );
    await editLines(
      result.id,
      {
        kind: 'update',
        lineId: before[0]!.id,
        description: 'First, corrected',
        amountPence: 9000,
      },
      audit,
    );

    const reordered = await raw!.invoiceLine.findMany({
      where: { invoiceId: result.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(reordered.map((line) => line.description)).toEqual([
      'Second',
      'First, corrected',
    ]);

    await editLines(result.id, { kind: 'remove', lineId: before[1]!.id }, audit);

    const after = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
      include: { lines: true },
    });
    expect(after.lines).toHaveLength(1);
    expect(after.netPence).toBe(9000);
  });

  it('refuses to edit the lines of a sent invoice', async () => {
    // The recipient is holding a copy. The remedy is a credit note, and the
    // rule has to hold in the store rather than only in the screen that
    // happens to hide the inputs.
    const result = await raise();
    if (!result.ok) return;
    await markSent(result.id, audit);

    const edit = await editLines(
      result.id,
      { kind: 'add', description: 'Sneaked in', amountPence: 5000 },
      audit,
    );
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.code).toBe('INVOICE_LOCKED');

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
      include: { lines: true },
    });
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.netPence).toBe(10_000);
  });

  it('refuses a line with no description', async () => {
    const result = await raise();
    if (!result.ok) return;

    const edit = await editLines(
      result.id,
      { kind: 'add', description: '   ', amountPence: 5000 },
      audit,
    );
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.code).toBe('NO_DESCRIPTION');
  });

  it('moves anything past its due date to overdue', async () => {
    // Nothing happens to an invoice being ignored, which is exactly the one
    // worth flagging — so the status cannot only be recalculated on write.
    const result = await raise(5000);
    if (!result.ok) return;
    await markSent(result.id, audit);

    const moved = await refreshOverdue(new Date(`${YEAR}-12-31T00:00:00Z`));
    expect(moved).toBeGreaterThan(0);

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(invoice.status).toBe('OVERDUE');
  });

  async function highestSequence(): Promise<number> {
    const rows = await raw!.$queryRaw<Array<{ max: number | null }>>`
      SELECT MAX(CAST(SUBSTRING("number" FROM '[0-9]+$') AS INTEGER)) AS max
      FROM "Invoice"
      WHERE "number" LIKE ${`%-${YEAR}-%`}
    `;
    return rows[0]?.max ?? 0;
  }
});
