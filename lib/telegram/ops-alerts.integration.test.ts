import { rawPrismaClient } from '../raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestFacts, overdueInvoices } from './chasing';

/**
 * What the two unprompted alerts actually select.
 *
 * The sending is gated on Telegram being switched on and needs a bot token,
 * so testing `alertOverdueInvoices` end to end here would test the gate and
 * nothing else — it returns zeros and every assertion passes whatever the
 * query does. The selection is the half that can be wrong without anybody
 * noticing: an overdue list that quietly includes a credit note is a list
 * somebody chases a paying client over, and a digest that misses a job with
 * no driver is worse than no digest, because it says the day is covered.
 *
 * So the alerting functions are thin wrappers over `overdueInvoices` and
 * `digestFacts`, and these test those against fixtures with a known answer.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/** A century of its own, so nothing else in the database lands on this day. */
const TODAY = new Date(Date.UTC(2114, 4, 9, 12, 0, 0));
const ZONE = 'Europe/London';

function dayOffset(days: number): Date {
  return new Date(TODAY.getTime() + days * 24 * 60 * 60 * 1000);
}

describe.skipIf(!DATABASE_AVAILABLE)('what the office is told without asking', () => {
  const invoiceIds: string[] = [];
  const jobIds: string[] = [];
  const driverIds: string[] = [];
  let numbers: string[] = [];

  async function makeInvoice(input: {
    status: string;
    dueDate: Date;
    grossPence?: number;
    paidPence?: number;
  }): Promise<string> {
    const number = `OD-${stamp}-${invoiceIds.length}`;
    const invoice = await raw!.invoice.create({
      data: {
        number,
        issueDate: dayOffset(-40),
        dueDate: input.dueDate,
        netPence: 10_000,
        vatPence: 2_000,
        grossPence: input.grossPence ?? 12_000,
        paidPence: input.paidPence ?? 0,
        status: input.status as never,
      },
    });
    invoiceIds.push(invoice.id);
    numbers.push(number);
    return number;
  }

  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driver.deleteMany({ where: { id: { in: driverIds } } });
    await raw.$disconnect();
  });

  describe('overdue invoices', () => {
    it('picks up what is late and owed, and nothing else', async () => {
      numbers = [];
      const late = await makeInvoice({ status: 'SENT', dueDate: dayOffset(-10) });
      const partly = await makeInvoice({
        status: 'PART_PAID',
        dueDate: dayOffset(-5),
        grossPence: 20_000,
        paidPence: 5_000,
      });
      const dueToday = await makeInvoice({ status: 'SENT', dueDate: TODAY });
      const notYet = await makeInvoice({ status: 'SENT', dueDate: dayOffset(10) });
      const settled = await makeInvoice({ status: 'PAID', dueDate: dayOffset(-20) });
      const draft = await makeInvoice({ status: 'DRAFT', dueDate: dayOffset(-20) });
      const credited = await makeInvoice({ status: 'CREDITED', dueDate: dayOffset(-20) });

      const rows = await overdueInvoices(TODAY, ZONE, 200);
      const found = rows.map((row) => row.number).filter((n) => numbers.includes(n));

      expect(found).toContain(late);
      expect(found).toContain(partly);

      // Due today is not late until tomorrow — `dueDate` is a date column.
      expect(found).not.toContain(dueToday);
      expect(found).not.toContain(notYet);
      expect(found).not.toContain(settled);
      // A draft has not been sent, so nobody owes anything yet.
      expect(found).not.toContain(draft);
      /*
       * And a credit note is not a debt. A credit note reverses an invoice
       * without money arriving, so chasing it means ringing a client about
       * an amount the operator has already written off.
       */
      expect(found).not.toContain(credited);
    });

    it('reports what is still owed, not what was billed', async () => {
      numbers = [];
      const partly = await makeInvoice({
        status: 'PART_PAID',
        dueDate: dayOffset(-3),
        grossPence: 20_000,
        paidPence: 15_000,
      });

      const row = (await overdueInvoices(TODAY, ZONE, 200)).find(
        (invoice) => invoice.number === partly,
      );

      expect(row?.owedPence).toBe(5_000);
      expect(row?.daysLate).toBe(3);
    });

    it('leaves out an invoice settled in full whose status was never moved', async () => {
      // Statuses drift. The arithmetic does not.
      numbers = [];
      const paidButSent = await makeInvoice({
        status: 'SENT',
        dueDate: dayOffset(-30),
        grossPence: 12_000,
        paidPence: 12_000,
      });

      const found = (await overdueInvoices(TODAY, ZONE, 200)).map((row) => row.number);
      expect(found).not.toContain(paidButSent);
    });
  });

  describe('the morning digest', () => {
    async function makeJob(input: {
      hour: number;
      driverId?: string | null;
      status?: string;
      pricePence?: number | null;
    }): Promise<string> {
      const reference = `DG-${stamp}-${jobIds.length}`;
      const job = await raw!.job.create({
        data: {
          reference,
          jobType: 'TRANSFER',
          status: (input.status ?? 'PENDING') as never,
          scheduledAt: new Date(Date.UTC(2114, 4, 9, input.hour, 0, 0)),
          pickupText: 'The Dorchester',
          dropoffText: 'Heathrow Terminal 5',
          clientPricePence: input.pricePence === undefined ? 12_000 : input.pricePence,
          driverId: input.driverId ?? null,
        },
      });
      jobIds.push(job.id);
      return reference;
    }

    it('counts the day and names the jobs with nobody on them', async () => {
      const driver = await raw!.driver.create({
        data: {
          reference: `DG-${stamp}`,
          name: `Digest Driver ${stamp}`,
          phone: `07700${stamp}`,
          status: 'ACTIVE',
        },
      });
      driverIds.push(driver.id);

      const covered = await makeJob({ hour: 9, driverId: driver.id });
      const gap = await makeJob({ hour: 11 });
      const cancelled = await makeJob({ hour: 13, status: 'CANCELLED' });

      const facts = await digestFacts(TODAY, ZONE);
      const references = facts.withoutDriver.map((job) => job.reference);

      expect(references).toContain(gap);
      expect(references).not.toContain(covered);
      // A cancelled job is not a hole in the day.
      expect(references).not.toContain(cancelled);
      expect(facts.total).toBeGreaterThanOrEqual(2);
    });

    it('counts the day in the configured zone, not in UTC', async () => {
      /*
       * The reason `digestFacts` takes a zone. A job at 23:30 London on the
       * 9th is 22:30 UTC and belongs to the 9th; one at 00:30 London on the
       * 10th is 23:30 UTC on the 9th and does not. A digest built on UTC days
       * would put tomorrow's first airport run in today's list, in summer,
       * which is exactly when the early runs matter.
       */
      const lateTonight = await makeJob({ hour: 22 }); // 23:00 BST on the 9th
      const earlyTomorrow = await makeJob({ hour: 23 }); // 00:00 BST on the 10th

      const facts = await digestFacts(TODAY, ZONE);
      const references = facts.withoutDriver.map((job) => job.reference);

      expect(references).toContain(lateTonight);
      expect(references).not.toContain(earlyTomorrow);
    });

    it('counts what has no price', async () => {
      const unpricedBefore = (await digestFacts(TODAY, ZONE)).unpriced;
      await makeJob({ hour: 15, pricePence: null });
      const after = await digestFacts(TODAY, ZONE);
      expect(after.unpriced).toBe(unpricedBefore + 1);
    });
  });
});
