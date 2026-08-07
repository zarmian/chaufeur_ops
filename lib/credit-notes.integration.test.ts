import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCreditNote, createInvoice, markSent } from './invoice-store';
import { listInvoices } from './invoice-list';
import { statusFor } from './invoices';

/**
 * A credit note settles the invoice it reverses.
 *
 * The defect this pins: the ledger showed Outstanding £2,005.20 against
 * Invoiced £1,789.80 — more owed than was ever billed. A credit note nets out
 * of "Invoiced" because its gross is negative, but contributed nothing to
 * "Outstanding" because `outstandingPence` floors at zero per invoice, while
 * the invoice it fully cancelled kept its whole balance. That invoice would
 * then age into `OVERDUE` and be chased for money already given back.
 *
 * The per-invoice flooring is deliberate and stays: one client's overpayment
 * must not offset another's arrears. What was missing is that a credit note
 * is not an unrelated negative — it belongs to a specific invoice, and the
 * `creditsInvoiceId` column had no relation so nothing could ask which.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const stamp = String(Date.now()).slice(-7);

/** Its own year, so these totals meet nothing else. */
const ISSUED = new Date('2113-03-10T00:00:00.000Z');
const GROSS_PENCE = 33_840; // £338.40, the figure from the report

describe.skipIf(!DATABASE_AVAILABLE)('credit notes settle their invoice', () => {
  const invoiceIds: string[] = [];
  let clientId = '';
  let invoiceId = '';

  beforeAll(async () => {
    if (!raw) return;

    const client = await raw.client.create({
      data: { name: `Credit Client ${stamp}`, normalisedName: `creditclient${stamp}` },
    });
    clientId = client.id;

    const created = await createInvoice(
      {
        clientId,
        accountId: null,
        issueDate: ISSUED,
        // Due in the past, so it would age into OVERDUE if nothing stopped it.
        dueDate: ISSUED,
        lines: [{ description: `Transfer ${stamp}`, amountPence: 28_200 }],
      },
      {},
    );
    if (!created.ok) throw new Error(created.message);
    invoiceId = created.id;
    invoiceIds.push(created.id);

    // A credit note may only be raised against an invoice that has been sent.
    await markSent(invoiceId, {});
  });

  afterAll(async () => {
    if (!raw) return;
    // Credit notes point at the invoice, so drop the link before deleting.
    await raw.invoice.updateMany({
      where: { id: { in: invoiceIds } },
      data: { creditsInvoiceId: null },
    });
    await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.client.deleteMany({ where: { id: clientId } });
    await raw.$disconnect();
  });

  it('starts with the invoice fully outstanding', async () => {
    const { totals } = await listInvoices(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: null, sort: null, dir: 'asc' },
      { q: null, status: null, clientId: null, accountId: null, from: ISSUED, to: ISSUED, overdueOnly: false },
    );

    expect(totals.invoicedPence).toBe(GROSS_PENCE);
    expect(totals.outstandingPence).toBe(GROSS_PENCE);
  });

  it('never reports more outstanding than was ever invoiced', async () => {
    // The headline. Outstanding £2,005.20 against Invoiced £1,789.80 is not a
    // rounding disagreement — it is a figure that cannot be true.
    const note = await createCreditNote(invoiceId, {});
    expect(note.ok, note.ok ? '' : note.message).toBe(true);
    if (note.ok) invoiceIds.push(note.id);

    // Two views, because the credit note carries today's issue date while the
    // invoice carries its own. A ledger filtered to the invoice's period
    // therefore sees the debt and not the credit — which is very likely how
    // this was first noticed, and is the harder case to get right.
    const windowed = await listInvoices(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: null, sort: null, dir: 'asc' },
      { q: null, status: null, clientId: null, accountId: null, from: ISSUED, to: ISSUED, overdueOnly: false },
    );

    // Invoiced in that period is still £338.40 — that is true and should not
    // change. What must not happen is owing more than was ever billed.
    expect(windowed.totals.invoicedPence).toBe(GROSS_PENCE);
    expect(windowed.totals.outstandingPence).toBe(0);
    expect(windowed.totals.outstandingPence).toBeLessThanOrEqual(
      windowed.totals.invoicedPence,
    );

    // And across the whole ledger, where the credit note is in scope too,
    // both figures net to nothing.
    const all = await listInvoices(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: null, sort: null, dir: 'asc' },
      { q: null, status: null, clientId: null, accountId: null, from: null, to: null, overdueOnly: false },
    );
    const mine = all.rows.filter((row) => invoiceIds.includes(row.id));
    expect(mine.reduce((sum, row) => sum + row.grossPence, 0)).toBe(0);
    expect(mine.reduce((sum, row) => sum + row.outstandingPence, 0)).toBe(0);
  });

  it('stops chasing the invoice it reversed', async () => {
    // "The credited invoice will age into Overdue and be chased for money
    // already credited" — the letter no client should ever receive.
    const { rows } = await listInvoices(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: null, sort: null, dir: 'asc' },
      { q: null, status: null, clientId: null, accountId: null, from: ISSUED, to: ISSUED, overdueOnly: true },
    );

    expect(rows.map((row) => row.id)).not.toContain(invoiceId);
  });

  it('shows a zero balance on the invoice it reversed', async () => {
    const { rows } = await listInvoices(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: null, sort: null, dir: 'asc' },
      { q: null, status: null, clientId: null, accountId: null, from: ISSUED, to: ISSUED, overdueOnly: false },
    );

    const original = rows.find((row) => row.id === invoiceId);
    expect(original).toBeTruthy();
    expect(original!.outstandingPence).toBe(0);
  });

  it('calls it credited, not paid', () => {
    // No money arrived. A ledger that called this PAID would not reconcile
    // against a bank statement, and that is a worse bug than the one it fixes.
    expect(
      statusFor(
        {
          status: 'OVERDUE',
          grossPence: GROSS_PENCE,
          paidPence: 0,
          creditedPence: GROSS_PENCE,
          dueDate: ISSUED,
        },
        new Date('2113-06-01T00:00:00.000Z'),
      ),
    ).toBe('CREDITED');
  });

  it('still calls a genuinely paid invoice paid', () => {
    expect(
      statusFor(
        {
          status: 'SENT',
          grossPence: GROSS_PENCE,
          paidPence: GROSS_PENCE,
          creditedPence: 0,
          dueDate: ISSUED,
        },
        new Date('2113-06-01T00:00:00.000Z'),
      ),
    ).toBe('PAID');
  });

  it('still chases an invoice with only a partial credit', () => {
    // A credit note for part of the value leaves the rest owed.
    expect(
      statusFor(
        {
          status: 'SENT',
          grossPence: GROSS_PENCE,
          paidPence: 0,
          creditedPence: 10_000,
          dueDate: ISSUED,
        },
        new Date('2113-06-01T00:00:00.000Z'),
      ),
    ).toBe('OVERDUE');
  });

  it('still refuses to let one client’s overpayment clear another’s debt', async () => {
    // The reason outstanding is floored per invoice in the first place. This
    // fix must not have quietly turned the ledger into SUM(gross) - SUM(paid).
    if (!raw) return;

    const overpaid = await raw.invoice.create({
      data: {
        number: `OVER-${stamp}`,
        clientId,
        issueDate: ISSUED,
        dueDate: ISSUED,
        netPence: 10_000,
        vatPence: 0,
        grossPence: 10_000,
        paidPence: 25_000,
        status: 'PAID',
      },
    });
    const owed = await raw.invoice.create({
      data: {
        number: `OWED-${stamp}`,
        clientId,
        issueDate: ISSUED,
        dueDate: ISSUED,
        netPence: 8_000,
        vatPence: 0,
        grossPence: 8_000,
        paidPence: 0,
        status: 'SENT',
      },
    });
    invoiceIds.push(overpaid.id, owed.id);

    const { totals } = await listInvoices(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: null, sort: null, dir: 'asc' },
      { q: null, status: null, clientId: null, accountId: null, from: ISSUED, to: ISSUED, overdueOnly: false },
    );

    // The £80 is still owed in full: the £150 overpayment is not a credit
    // against it.
    expect(totals.outstandingPence).toBe(8_000);
  });
});
