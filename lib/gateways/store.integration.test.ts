import { rawPrismaClient } from '../raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvoice, markSent } from '../invoice-store';
import { recordGatewayPayment } from './store';
import type { IncomingPayment } from './types';

/**
 * Recording a gateway payment against a real invoice.
 *
 * The rule this exists for is idempotency. Providers retry webhooks — for
 * days, on any non-2xx, and sometimes for no reason at all — and a handler
 * that inserted on every delivery would credit one payment three times and
 * leave an invoice reading as overpaid.
 *
 * The second rule is that a gateway payment and a typed one leave the invoice
 * in the same state. Two paths to `PAID` that disagree would make the ledger
 * depend on how the money happened to arrive.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-8);
const YEAR = 2118;
const ISSUE = new Date(`${YEAR}-05-01T00:00:00Z`);

function event(overrides: Partial<IncomingPayment> = {}): IncomingPayment {
  return {
    gateway: 'revolut',
    gatewayTxnId: `ord_${stamp}`,
    invoiceId: null,
    amountPence: 10_000,
    currency: 'GBP',
    receivedAt: new Date(`${YEAR}-05-10T12:00:00Z`),
    status: 'received',
    ...overrides,
  };
}

describe.skipIf(!DATABASE_AVAILABLE)('gateway payments', () => {
  let accountId = '';
  const invoiceIds: string[] = [];

  async function raiseAndSend(amountPence: number): Promise<string> {
    const result = await createInvoice(
      {
        accountId,
        issueDate: ISSUE,
        lines: [{ description: 'Transfer', amountPence }],
      },
      audit,
    );
    if (!result.ok) throw new Error(result.message);
    invoiceIds.push(result.id);
    await markSent(result.id, audit);
    return result.id;
  }

  beforeAll(async () => {
    if (!raw) return;
    const account = await raw.account.create({
      data: { name: `Gateway Account ${stamp}`, kind: 'CORPORATE' },
      select: { id: true },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.account.deleteMany({ where: { id: accountId } });
    await raw.$disconnect();
  });

  it('credits an invoice and settles it, exactly as a typed payment would', async () => {
    // £100 net, £20 VAT, £120 gross.
    const invoiceId = await raiseAndSend(10_000);

    const result = await recordGatewayPayment(
      event({ invoiceId, amountPence: 12_000 }),
      audit,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true);

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });

    expect(invoice.paidPence).toBe(12_000);
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).not.toBeNull();
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.payments[0]?.gateway).toBe('revolut');
  });

  it('ignores a redelivery of the same transaction', async () => {
    // The rule the whole handler exists for. A provider retrying for two days
    // must not credit the invoice forty times.
    const invoiceId = await raiseAndSend(5000);
    const txn = `ord_dupe_${stamp}`;

    const first = await recordGatewayPayment(
      event({ invoiceId, gatewayTxnId: txn, amountPence: 6000 }),
      audit,
    );
    expect(first.ok && first.created).toBe(true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await recordGatewayPayment(
        event({ invoiceId, gatewayTxnId: txn, amountPence: 6000 }),
        audit,
      );
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.created).toBe(false);
    }

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.paidPence).toBe(6000);
  });

  it('leaves a part payment part paid rather than settled', async () => {
    const invoiceId = await raiseAndSend(20_000);

    await recordGatewayPayment(
      event({
        invoiceId,
        gatewayTxnId: `ord_part_${stamp}`,
        amountPence: 10_000,
      }),
      audit,
    );

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    expect(invoice.paidPence).toBe(10_000);
    expect(invoice.status).toBe('PART_PAID');
    expect(invoice.paidAt).toBeNull();
  });

  it('records nothing for an event that is not a completion', async () => {
    const invoiceId = await raiseAndSend(3000);

    for (const status of ['pending', 'failed'] as const) {
      const result = await recordGatewayPayment(
        event({
          invoiceId,
          gatewayTxnId: `ord_${status}_${stamp}`,
          status,
        }),
        audit,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_SETTLED');
    }

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    expect(invoice.payments).toHaveLength(0);
    expect(invoice.paidPence).toBe(0);
  });

  it('refuses an event carrying no invoice reference', async () => {
    // Rather than guessing from the amount: two clients paying the same
    // figure on the same afternoon are indistinguishable, and a guess credits
    // the wrong invoice.
    const result = await recordGatewayPayment(
      event({ invoiceId: null, gatewayTxnId: `ord_orphan_${stamp}` }),
      audit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_INVOICE');
  });

  it('refuses an event for an invoice that does not exist', async () => {
    const result = await recordGatewayPayment(
      event({
        invoiceId: 'cmnothinghere0000000000',
        gatewayTxnId: `ord_missing_${stamp}`,
      }),
      audit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('keeps the same transaction id apart across gateways', async () => {
    // Two providers can independently mint `1`. Matching on the id alone
    // would make a SumUp payment look like a Revolut redelivery.
    const invoiceId = await raiseAndSend(4000);
    const shared = `shared_${stamp}`;

    const first = await recordGatewayPayment(
      event({ invoiceId, gateway: 'revolut', gatewayTxnId: shared, amountPence: 2400 }),
      audit,
    );
    const second = await recordGatewayPayment(
      event({ invoiceId, gateway: 'sumup', gatewayTxnId: shared, amountPence: 2400 }),
      audit,
    );

    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(true);

    const invoice = await raw!.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    expect(invoice.payments).toHaveLength(2);
  });
});
