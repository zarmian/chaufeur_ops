import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addJobLine, createInvoice, editLines } from './invoice-store';
import { invoiceDocumentHtml } from './invoice-pdf';

/**
 * Tax and line detail, from the job to the printed document.
 *
 * The unit tests cover the arithmetic and the template with data handed to
 * them. What only this can prove is the half that goes through Postgres: that
 * a job's treatment reaches the invoice it lands on, that the parking recorded
 * against that job comes out of the tax base, and that the line the client
 * reads names the booking rather than its reference.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-6);

/** A year of its own, so nothing here collides with a seeded invoice. */
const YEAR = 2118;
const ISSUE = new Date(`${YEAR}-04-01T00:00:00Z`);

let standardAccountId = '';
let exemptAccountId = '';
const invoiceIds: string[] = [];
const jobIds: string[] = [];

describe.skipIf(!DATABASE_AVAILABLE)('tax on an invoice', () => {
  async function cleanup() {
    if (!raw) return;
    const ours = await raw.invoice.findMany({
      where: { number: { contains: `-${YEAR}-` } },
      select: { id: true },
    });
    const ids = [...new Set([...invoiceIds, ...ours.map((row) => row.id)])];
    if (ids.length > 0) {
      await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: ids } } });
      await raw.invoice.deleteMany({ where: { id: { in: ids } } });
    }
    if (jobIds.length > 0) {
      await raw.jobExpense.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    }
  }

  beforeAll(async () => {
    if (!raw) return;
    await cleanup();
    const [standard, exempt] = await Promise.all([
      raw.account.create({
        data: { name: `Taxed Booker ${stamp}`, kind: 'CORPORATE' },
      }),
      raw.account.create({
        // A partner who is not registered: their work carries none.
        data: {
          name: `Untaxed Booker ${stamp}`,
          kind: 'AGENCY',
          vatTreatment: 'EXEMPT',
        },
      }),
    ]);
    standardAccountId = standard.id;
    exemptAccountId = exempt.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await cleanup();
    await raw.account.deleteMany({
      where: { id: { in: [standardAccountId, exemptAccountId] } },
    });
    await raw.$disconnect();
  });

  /** A completed airport transfer, priced, optionally with recharged expenses. */
  async function bookJob(options: {
    accountId: string;
    pricePence: number;
    expenses?: Array<{ kind: string; amountPence: number }>;
    vatTreatment?: 'STANDARD' | 'INCLUSIVE' | 'EXEMPT';
  }) {
    const job = await raw!.job.create({
      data: {
        reference: `JOB-V${stamp}-${jobIds.length}`,
        accountId: options.accountId,
        jobType: 'AIRPORT_TRANSFER',
        status: 'COMPLETED',
        scheduledAt: new Date(`${YEAR}-03-20T09:30:00Z`),
        pickupText: 'London Heathrow Terminal 3',
        dropoffText: 'The Marylebone Hotel, 47 Welbeck Street',
        clientPricePence: options.pricePence,
        vatTreatment: options.vatTreatment ?? null,
        expenses: options.expenses
          ? {
              create: options.expenses.map((expense) => ({
                kind: expense.kind as never,
                amountPence: expense.amountPence,
                borneBy: 'CLIENT' as const,
                rechargeToClient: true,
              })),
            }
          : undefined,
      },
    });
    jobIds.push(job.id);
    return job;
  }

  async function draft() {
    const result = await createInvoice(
      {
        accountId: standardAccountId,
        issueDate: ISSUE,
        // A placeholder, removed once the job lines are on: an invoice needs
        // at least one line to exist.
        lines: [{ description: 'Opening balance', amountPence: 0 }],
      },
      audit,
    );
    if (!result.ok) throw new Error(result.message);
    invoiceIds.push(result.id);
    return result.id;
  }

  it('puts the booking on the line, not just its reference', async () => {
    // The complaint. A line reading "JOB-000123" cannot be checked against a
    // diary without opening the job.
    const job = await bookJob({ accountId: standardAccountId, pricePence: 9000 });
    const invoiceId = await draft();
    expect((await addJobLine(invoiceId, job.id, audit)).ok).toBe(true);

    const line = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId, jobId: job.id },
    });
    expect(line.description).toContain('Airport transfer');
    expect(line.description).toContain(job.reference);
    expect(line.description).toContain('Pick up: London Heathrow Terminal 3');
    expect(line.description).toContain('Drop off: The Marylebone Hotel');
    // 09:30 UTC in March is 09:30 in London — the clocks go forward on the
    // 29th that year. What matters is that it is a readable date at all.
    expect(line.description).toMatch(/20 March|20 Mar/);
  });

  it('keeps parking and drop-off charges out of the tax base', async () => {
    // Asked for explicitly. £90 fare, £7.50 car park and £6 drop-off: tax is
    // 20% of £90, not of £103.50.
    const job = await bookJob({
      accountId: standardAccountId,
      pricePence: 9000,
      expenses: [
        { kind: 'PARKING', amountPence: 750 },
        { kind: 'DROPOFF_CHARGE', amountPence: 600 },
      ],
    });
    const invoiceId = await draft();
    // Drop the placeholder so the totals are the job's alone.
    const placeholder = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    await editLines(invoiceId, { kind: 'remove', lineId: placeholder.id }, audit);
    expect((await addJobLine(invoiceId, job.id, audit)).ok).toBe(true);

    const line = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId, jobId: job.id },
    });
    expect(line.amountPence).toBe(10_350);
    expect(line.disbursementPence).toBe(1350);

    const invoice = await raw!.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.netPence).toBe(10_350);
    expect(invoice.vatPence).toBe(1800);
    expect(invoice.grossPence).toBe(12_150);
  });

  it('charges no tax on a booker who is not registered', async () => {
    const job = await bookJob({ accountId: exemptAccountId, pricePence: 20_000 });
    const invoiceId = await draft();
    const placeholder = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    await editLines(invoiceId, { kind: 'remove', lineId: placeholder.id }, audit);
    expect((await addJobLine(invoiceId, job.id, audit)).ok).toBe(true);

    const line = await raw!.invoiceLine.findFirstOrThrow({ where: { invoiceId } });
    expect(line.vatTreatment).toBe('EXEMPT');

    const invoice = await raw!.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.vatPence).toBe(0);
    expect(invoice.grossPence).toBe(20_000);
  });

  it('backs tax out of a job priced inclusive of it', async () => {
    // £120 agreed inclusive is £100 of work and £20 of tax. Adding 20% on top
    // would charge the client for tax they have already paid.
    const job = await bookJob({
      accountId: standardAccountId,
      pricePence: 12_000,
      vatTreatment: 'INCLUSIVE',
    });
    const invoiceId = await draft();
    const placeholder = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    await editLines(invoiceId, { kind: 'remove', lineId: placeholder.id }, audit);
    expect((await addJobLine(invoiceId, job.id, audit)).ok).toBe(true);

    const invoice = await raw!.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.netPence).toBe(10_000);
    expect(invoice.vatPence).toBe(2000);
    expect(invoice.grossPence).toBe(12_000);
  });

  it('totals an invoice that mixes all three', async () => {
    const invoiceId = await draft();
    const placeholder = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    await editLines(invoiceId, { kind: 'remove', lineId: placeholder.id }, audit);

    await editLines(
      invoiceId,
      { kind: 'add', description: 'Taxed work', amountPence: 10_000 },
      audit,
    );
    await editLines(
      invoiceId,
      {
        kind: 'add',
        description: 'Priced inclusive',
        amountPence: 12_000,
        vatTreatment: 'INCLUSIVE',
      },
      audit,
    );
    await editLines(
      invoiceId,
      {
        kind: 'add',
        description: 'Not qualifying',
        amountPence: 5000,
        vatTreatment: 'EXEMPT',
      },
      audit,
    );
    await editLines(
      invoiceId,
      {
        kind: 'add',
        description: 'Car park, paid on their behalf',
        amountPence: 750,
        disbursementPence: 750,
      },
      audit,
    );

    const invoice = await raw!.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    // Net: £100 taxed + (£120 inclusive backing out to £100) + £50 exempt +
    // £7.50 pass-through.
    expect(invoice.netPence).toBe(25_750);
    // Tax: £20 on the taxed line, £20 already inside the inclusive one, and
    // nothing on either the exempt line or the car park.
    expect(invoice.vatPence).toBe(4000);
    expect(invoice.grossPence).toBe(29_750);

    // And the document says which is which rather than averaging them.
    const html = await invoiceDocumentHtml(invoiceId);
    expect(html).toContain('included above');
    expect(html).toContain('not chargeable');
    expect(html).toContain('paid on your behalf');
  });

  it('reverses an exempt line as exempt', async () => {
    // A credit note that hands back tax on a line that never carried any
    // gives the client money the company never collected.
    const invoiceId = await draft();
    const placeholder = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    await editLines(invoiceId, { kind: 'remove', lineId: placeholder.id }, audit);
    await editLines(
      invoiceId,
      {
        kind: 'add',
        description: 'Not qualifying',
        amountPence: 20_000,
        vatTreatment: 'EXEMPT',
      },
      audit,
    );

    const { createCreditNote, markSent } = await import('./invoice-store');
    await markSent(invoiceId, audit);
    const note = await createCreditNote(invoiceId, audit);
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    invoiceIds.push(note.id);

    const reversed = await raw!.invoice.findUniqueOrThrow({ where: { id: note.id } });
    expect(reversed.vatPence).toBe(0);
    expect(reversed.grossPence).toBe(-20_000);
  });
});
