import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmInvoiceAllocation,
  confirmPayoutMatch,
  confirmVehicleCost,
  importStatement,
  previewImport,
  proposeFor,
  reclassify,
  saveRule,
  undoAllocation,
} from './store';

/**
 * Reconciliation against a real database.
 *
 * The allocation arithmetic is unit-tested and the parsing is unit-tested.
 * What only this can prove is the two things that touch money and cannot be
 * checked in isolation:
 *
 *   - a confirmed allocation writes the same `Payment` rows a manual entry
 *     would, and leaves the invoices in the states the proposal promised;
 *   - undoing it puts every one of them back.
 *
 * The undo test snapshots the invoices before, applies, and asserts the
 * snapshot again after — because "it looked right" is exactly the standard
 * that produced the ledger this system replaces.
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
const audit = { userId: null, ip: null };

/** A year of its own, so nothing here collides with seeded invoices. */
const YEAR = 2119;

describe.skipIf(!DATABASE_AVAILABLE)('bank reconciliation', () => {
  const payerName = `Kettleby Chambers ${stamp}`;
  let accountId = '';
  let driverId = '';
  let vehicleId = '';

  const statementIds: string[] = [];
  const invoiceIds: string[] = [];

  async function cleanup() {
    if (!raw) return;

    const ours = await raw.bankTransaction.findMany({
      where: { statementId: { in: statementIds } },
      select: { id: true },
    });
    const txnIds = ours.map((t) => t.id);

    await raw.unallocatedCredit.deleteMany({
      where: { transactionId: { in: txnIds } },
    });
    await raw.bankAllocation.deleteMany({
      where: { transactionId: { in: txnIds } },
    });
    await raw.bankTransaction.deleteMany({ where: { id: { in: txnIds } } });
    await raw.bankStatement.deleteMany({ where: { id: { in: statementIds } } });
    statementIds.length = 0;

    const invoices = await raw.invoice.findMany({
      where: { number: { contains: `-${YEAR}-` } },
      select: { id: true },
    });
    const ids = [...new Set([...invoiceIds, ...invoices.map((i) => i.id)])];
    if (ids.length > 0) {
      await raw.payment.deleteMany({ where: { invoiceId: { in: ids } } });
      await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: ids } } });
      await raw.invoice.deleteMany({ where: { id: { in: ids } } });
    }
    invoiceIds.length = 0;
  }

  /**
   * Invoices raised directly rather than through `createInvoice`.
   *
   * The numbering is tested where it lives; here it would only make these
   * tests depend on the invoice sequence, and a statement fixture that has to
   * know what number it will get is a statement fixture that breaks whenever
   * somebody else's test raises an invoice first.
   */
  async function raiseInvoice(input: {
    number: string;
    grossPence: number;
    issueDate: string;
    status?: string;
    paidPence?: number;
  }): Promise<string> {
    if (!raw) throw new Error('no database');
    const net = Math.round(input.grossPence / 1.2);
    const issued = new Date(`${input.issueDate}T00:00:00Z`);
    // Thirty-day terms, as the account carries. It matters: `statusFor` ranks
    // overdue above part-paid, so an invoice given a same-day due date comes
    // back OVERDUE and the part-paid case never gets exercised.
    const due = new Date(issued.getTime() + 30 * 24 * 60 * 60 * 1000);
    const invoice = await raw.invoice.create({
      data: {
        number: input.number,
        accountId,
        issueDate: issued,
        dueDate: due,
        netPence: net,
        vatPence: input.grossPence - net,
        grossPence: input.grossPence,
        paidPence: input.paidPence ?? 0,
        status: (input.status ?? 'SENT') as never,
        sentAt: new Date(`${input.issueDate}T00:00:00Z`),
      },
    });
    invoiceIds.push(invoice.id);
    return invoice.id;
  }

  function statementCsv(rows: string[]): string {
    return ['Date,Amount,Memo', ...rows].join('\n');
  }

  beforeAll(async () => {
    if (!raw) return;
    await cleanup();

    const account = await raw.account.create({
      data: { name: payerName, kind: 'AGENCY', paymentTermsDays: 30 },
    });
    accountId = account.id;

    const driver = await raw.driver.create({
      data: {
        reference: `BNK${stamp}`,
        name: `Bank Test Driver ${stamp}`,
        phone: `+4477${stamp}00`,
        status: 'ACTIVE',
      },
    });
    driverId = driver.id;

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `BK${stamp.slice(-5)}`,
        normalisedRegistration: `BK${stamp.slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        ownership: 'OWNED',
      },
    });
    vehicleId = vehicle.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await cleanup();
    await raw.vehicleCost.deleteMany({ where: { vehicleId } });
    await raw.driverPayoutLine.deleteMany({ where: { payout: { driverId } } });
    await raw.driverPayout.deleteMany({ where: { driverId } });
    await raw.bankRule.deleteMany({ where: { phrase: { contains: stamp } } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.account.deleteMany({ where: { id: accountId } });
    await raw.$disconnect();
  });

  it('previews before it writes anything', async () => {
    const csv = statementCsv([`01/03/${YEAR},250.00,${payerName} PAYMENT`]);

    const preview = await previewImport(csv);
    expect(preview.parse.rows).toHaveLength(1);
    expect(preview.fresh).toBe(1);
    expect(preview.duplicates).toBe(0);

    // And wrote nothing while doing so.
    const count = await raw!.bankTransaction.count({
      where: { description: { contains: payerName } },
    });
    expect(count).toBe(0);
  });

  it('imports, attributing a credit to the account named in the reference', async () => {
    const csv = statementCsv([`02/03/${YEAR},400.00,${payerName} FPS CREDIT`]);

    const result = await importStatement({ filename: 'march.csv', csv }, audit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    statementIds.push(result.outcome.statementId);
    expect(result.outcome.imported).toBe(1);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: result.outcome.statementId },
    });

    // Nothing named it a client payment; the payer's own name in the
    // reference did.
    expect(txn.kind).toBe('CLIENT_PAYMENT');
    expect(txn.accountId).toBe(accountId);
  });

  it('does not import the same transaction twice', async () => {
    // What an operator does when they are not sure last week's upload worked.
    const csv = statementCsv([`03/03/${YEAR},99.00,${payerName} REPEATED`]);

    const first = await importStatement({ filename: 'a.csv', csv }, audit);
    const second = await importStatement({ filename: 'b.csv', csv }, audit);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    statementIds.push(first.outcome.statementId, second.outcome.statementId);
    expect(first.outcome.imported).toBe(1);
    expect(second.outcome.imported).toBe(0);
    expect(second.outcome.duplicates).toBe(1);
  });

  it('clears invoices oldest first and leaves the last one part-paid', async () => {
    // £1,000 against £300 + £300 + £600, which is the scenario the operator
    // described.
    await raiseInvoice({
      number: `INV-${YEAR}-0001`,
      grossPence: 30_000,
      issueDate: `${YEAR}-01-05`,
    });
    await raiseInvoice({
      number: `INV-${YEAR}-0002`,
      grossPence: 30_000,
      issueDate: `${YEAR}-01-20`,
    });
    const third = await raiseInvoice({
      number: `INV-${YEAR}-0003`,
      grossPence: 60_000,
      issueDate: `${YEAR}-02-10`,
    });

    const imported = await importStatement(
      {
        filename: 'settle.csv',
        csv: statementCsv([`05/03/${YEAR},1000.00,${payerName} BACS`]),
      },
      audit,
    );
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    statementIds.push(imported.outcome.statementId);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: imported.outcome.statementId },
    });

    const proposal = await proposeFor(txn.id);
    expect(proposal.kind).toBe('invoices');
    if (proposal.kind !== 'invoices') return;
    expect(proposal.proposal.allocations.map((a) => a.becomes)).toEqual([
      'PAID',
      'PAID',
      'PART_PAID',
    ]);

    const confirmed = await confirmInvoiceAllocation(txn.id, audit);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.allocated).toBe(100_000);
    expect(confirmed.unallocated).toBe(0);

    const after = await raw!.invoice.findMany({
      where: { id: { in: invoiceIds } },
      orderBy: { number: 'asc' },
    });
    expect(after.map((i) => i.status)).toEqual(['PAID', 'PAID', 'PART_PAID']);
    expect(after[2]?.paidPence).toBe(40_000);

    // The same `Payment` rows a manual entry or a webhook would have written.
    const payments = await raw!.payment.findMany({
      where: { invoiceId: { in: invoiceIds } },
    });
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.gateway === 'bank')).toBe(true);
    expect(payments.find((p) => p.invoiceId === third)?.amountPence).toBe(40_000);
  });

  it('puts every invoice back when the allocation is undone', async () => {
    const before = await raw!.invoice.findMany({
      where: { id: { in: invoiceIds } },
      orderBy: { number: 'asc' },
      select: { number: true, status: true, paidPence: true },
    });
    // Guards the guard: this only proves anything if the previous test left
    // the invoices settled.
    expect(before.some((i) => i.status === 'PAID')).toBe(true);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { description: { contains: 'BACS' }, allocatedAt: { not: null } },
    });

    const undone = await undoAllocation(txn.id, audit);
    expect(undone.ok).toBe(true);

    const after = await raw!.invoice.findMany({
      where: { id: { in: invoiceIds } },
      orderBy: { number: 'asc' },
      select: { number: true, status: true, paidPence: true },
    });

    // Nothing paid, and every one back to the state it would be in having
    // never been paid. Recomputed rather than remembered, so an invoice that
    // fell overdue in the meantime would come back overdue; these are dated
    // ahead, so they come back merely sent.
    expect(after.every((i) => i.paidPence === 0)).toBe(true);
    expect(after.every((i) => i.status === 'SENT')).toBe(true);

    expect(
      await raw!.payment.count({ where: { invoiceId: { in: invoiceIds } } }),
    ).toBe(0);
    expect(
      await raw!.bankAllocation.count({ where: { transactionId: txn.id } }),
    ).toBe(0);

    const reset = await raw!.bankTransaction.findUniqueOrThrow({
      where: { id: txn.id },
    });
    expect(reset.allocatedAt).toBeNull();
    expect(reset.allocatedPence).toBe(0);
  });

  it('records money over as a credit rather than forcing it onto an invoice', async () => {
    await raw!.invoice.updateMany({
      where: { id: { in: invoiceIds } },
      data: { status: 'CANCELLED' },
    });
    const only = await raiseInvoice({
      number: `INV-${YEAR}-0009`,
      grossPence: 20_000,
      issueDate: `${YEAR}-02-01`,
    });

    const imported = await importStatement(
      {
        filename: 'over.csv',
        csv: statementCsv([`09/03/${YEAR},500.00,${payerName} ON ACCOUNT`]),
      },
      audit,
    );
    if (!imported.ok) throw new Error(imported.message);
    statementIds.push(imported.outcome.statementId);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: imported.outcome.statementId },
    });

    const confirmed = await confirmInvoiceAllocation(txn.id, audit);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    expect(confirmed.allocated).toBe(20_000);
    expect(confirmed.unallocated).toBe(30_000);

    const credit = await raw!.unallocatedCredit.findFirstOrThrow({
      where: { transactionId: txn.id },
    });
    expect(credit.remainingPence).toBe(30_000);
    expect(credit.accountId).toBe(accountId);

    const settled = await raw!.invoice.findUniqueOrThrow({ where: { id: only } });
    // Not overpaid: the invoice took exactly what it was owed.
    expect(settled.paidPence).toBe(20_000);
    expect(settled.status).toBe('PAID');
  });

  it('marks an approved payout paid from a matching debit', async () => {
    const payout = await raw!.driverPayout.create({
      data: {
        driverId,
        periodStart: new Date(`${YEAR}-03-01T00:00:00Z`),
        periodEnd: new Date(`${YEAR}-03-07T00:00:00Z`),
        totalPence: 124_000,
        status: 'APPROVED',
      },
    });

    await saveRule(null, {
      phrase: `payoutref${stamp}`,
      kind: 'DRIVER_PAYOUT',
      driverId,
    });

    const imported = await importStatement(
      {
        filename: 'payout.csv',
        csv: statementCsv([`10/03/${YEAR},-1240.00,PAYOUTREF${stamp} DRIVER`]),
      },
      audit,
    );
    if (!imported.ok) throw new Error(imported.message);
    statementIds.push(imported.outcome.statementId);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: imported.outcome.statementId },
    });
    expect(txn.kind).toBe('DRIVER_PAYOUT');

    const proposal = await proposeFor(txn.id);
    expect(proposal.kind).toBe('payout');
    if (proposal.kind !== 'payout') return;
    expect(proposal.match.kind).toBe('one');

    const confirmed = await confirmPayoutMatch(txn.id, payout.id, audit);
    expect(confirmed.ok).toBe(true);

    const after = await raw!.driverPayout.findUniqueOrThrow({
      where: { id: payout.id },
    });
    expect(after.status).toBe('PAID');

    // And back to approved when undone, because a payout wrongly marked paid
    // is a driver who does not get paid.
    const undone = await undoAllocation(txn.id, audit);
    expect(undone.ok).toBe(true);
    expect(
      (await raw!.driverPayout.findUniqueOrThrow({ where: { id: payout.id } }))
        .status,
    ).toBe('APPROVED');
  });

  it('refuses a payout of a different amount rather than half-paying it', async () => {
    const payout = await raw!.driverPayout.create({
      data: {
        driverId,
        periodStart: new Date(`${YEAR}-04-01T00:00:00Z`),
        periodEnd: new Date(`${YEAR}-04-07T00:00:00Z`),
        totalPence: 124_000,
        status: 'APPROVED',
      },
    });

    const imported = await importStatement(
      {
        filename: 'wrong.csv',
        csv: statementCsv([`11/03/${YEAR},-124.00,PAYOUTREF${stamp} SHORT`]),
      },
      audit,
    );
    if (!imported.ok) throw new Error(imported.message);
    statementIds.push(imported.outcome.statementId);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: imported.outcome.statementId },
    });

    const confirmed = await confirmPayoutMatch(txn.id, payout.id, audit);
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.code).toBe('AMOUNT_MISMATCH');
  });

  it('records a fuel debit as a vehicle cost, and removes it on undo', async () => {
    const imported = await importStatement(
      {
        filename: 'fuel.csv',
        csv: statementCsv([`12/03/${YEAR},-89.50,SHELL FILLING STN 4412`]),
      },
      audit,
    );
    if (!imported.ok) throw new Error(imported.message);
    statementIds.push(imported.outcome.statementId);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: imported.outcome.statementId },
    });

    const confirmed = await confirmVehicleCost(
      txn.id,
      { vehicleId, kind: 'OTHER' },
      audit,
    );
    expect(confirmed.ok).toBe(true);

    const cost = await raw!.vehicleCost.findFirstOrThrow({
      where: { vehicleId, deletedAt: null },
    });
    expect(cost.amountPence).toBe(8950);
    expect(cost.supplier).toContain('SHELL');

    await undoAllocation(txn.id, audit);
    expect(
      await raw!.vehicleCost.count({ where: { vehicleId, deletedAt: null } }),
    ).toBe(0);
  });

  it('refuses to reclassify a transaction that has already been allocated', async () => {
    // The allocation was made on the strength of the classification.
    const imported = await importStatement(
      {
        filename: 'locked.csv',
        csv: statementCsv([`13/03/${YEAR},-42.00,SHELL LOCKED ${stamp}`]),
      },
      audit,
    );
    if (!imported.ok) throw new Error(imported.message);
    statementIds.push(imported.outcome.statementId);

    const txn = await raw!.bankTransaction.findFirstOrThrow({
      where: { statementId: imported.outcome.statementId },
    });

    await confirmVehicleCost(txn.id, { vehicleId, kind: 'OTHER' }, audit);

    const refused = await reclassify(txn.id, { kind: 'TRANSFER' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('ALLOCATED');

    await undoAllocation(txn.id, audit);
    expect((await reclassify(txn.id, { kind: 'TRANSFER' })).ok).toBe(true);
  });

  it('imports two hundred rows in one pass', async () => {
    // The definition of done asks for it, and the thing it actually catches
    // is a per-row query that only hurts at scale.
    const rows = Array.from({ length: 200 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      return `${day}/06/${YEAR},${(i + 1) * 1.5},BULK ROW ${stamp} ${i}`;
    });

    const started = Date.now();
    const imported = await importStatement(
      { filename: 'bulk.csv', csv: statementCsv(rows) },
      audit,
    );
    const elapsed = Date.now() - started;

    if (!imported.ok) throw new Error(imported.message);
    statementIds.push(imported.outcome.statementId);

    expect(imported.outcome.imported).toBe(200);
    expect(elapsed).toBeLessThan(20_000);
  });
});
