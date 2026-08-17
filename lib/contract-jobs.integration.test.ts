import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDriverConflicts } from './conflict-store';
import { createInvoice, addJobLine } from './invoice-store';
import { createJob, jobSchema } from './jobs';

/**
 * Contract hire, from the booking form to the invoice.
 *
 * A contract is one job covering a block of days at a day rate. Three things
 * only a database can show: that the block is stored and priced, that it holds
 * the driver for every day of it rather than for an hour on the first morning,
 * and that it reaches the invoice as days rather than as one anonymous trip.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-7);

let driverId = '';
let accountId = '';
const jobIds: string[] = [];
const invoiceIds: string[] = [];

/** A summer block, so a mishandled timezone shows up as a day's drift. */
const START_DATE = '2026-07-27'; // Monday
const END_DATE = '2026-07-31'; // Friday — five days, counting both ends

const form = (overrides: Record<string, unknown> = {}) =>
  jobSchema.parse({
    jobType: 'CONTRACT',
    scheduledDate: START_DATE,
    scheduledTime: '09:00',
    pickupText: 'The Connaught, Carlos Place',
    dropoffText: 'As directed',
    contractEndsOn: END_DATE,
    customerDays: '5',
    customerDayRatePence: '400.00',
    driverDayRatePence: '180.00',
    accountId,
    driverId,
    ...overrides,
  });

describe.skipIf(!DATABASE_AVAILABLE)('contract hire', () => {
  beforeAll(async () => {
    if (!raw) return;
    const [driver, account] = await Promise.all([
      raw.driver.create({
        data: {
          name: `Contract Driver ${stamp}`,
          phone: `07700 7${stamp}`,
          normalisedPhone: `77007${stamp}`,
          reference: `DRV-C${stamp}`,
        },
      }),
      raw.account.create({
        data: { name: `Contract Client ${stamp}`, kind: 'CORPORATE' },
      }),
    ]);
    driverId = driver.id;
    accountId = account.id;
  });

  beforeEach(async () => {
    if (!raw) return;
    await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    jobIds.length = 0;
    invoiceIds.length = 0;
  });

  afterAll(async () => {
    if (!raw) return;
    const ours = await raw.job.findMany({
      where: { reference: { contains: stamp } },
      select: { id: true },
    });
    const ids = [...new Set([...jobIds, ...ours.map((job) => job.id)])];
    await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoiceLine.deleteMany({ where: { jobId: { in: ids } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
    await raw.jobFinance.deleteMany({ where: { jobId: { in: ids } } });
    await raw.job.deleteMany({ where: { id: { in: ids } } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.account.deleteMany({ where: { id: accountId } });
    await raw.$disconnect();
  });

  async function book(overrides: Record<string, unknown> = {}) {
    const job = await createJob(form(overrides), audit);
    jobIds.push(job.id);
    return job.id;
  }

  it('prices five days at the day rate', async () => {
    const id = await book();
    const finance = await raw!.jobFinance.findUniqueOrThrow({
      where: { jobId: id },
    });

    expect(Number(finance.customerDays)).toBe(5);
    expect(finance.customerDayRatePence).toBe(40_000);
    expect(finance.totalClientPence).toBe(200_000);

    // The driver's days follow the client's without being retyped, and the
    // gross profit is the difference between the two day rates.
    expect(Number(finance.driverDays)).toBe(5);
    expect(finance.totalCostsPence).toBe(90_000);
    expect(finance.grossProfitPence).toBe(110_000);
  });

  it('stores the block as running to the end of its last day', async () => {
    // Not to midnight at the start of Friday, which would end the contract
    // before the Friday it covers.
    const id = await book();
    const job = await raw!.job.findUniqueOrThrow({ where: { id } });

    expect(job.contractEndsAt).not.toBeNull();
    // 23:59:59.999 on the Friday, London time — which in BST is 22:59:59.999
    // UTC. Storing the exclusive bound instead would print the contract as
    // ending on the Saturday.
    expect(job.contractEndsAt!.toISOString()).toBe('2026-07-31T22:59:59.999Z');
  });

  it('applies a minimum term', async () => {
    // A three-day booking on a five-day minimum bills five.
    const id = await book({
      contractEndsOn: '2026-07-29',
      customerDays: '3',
      minimumDays: '5',
    });
    const finance = await raw!.jobFinance.findUniqueOrThrow({
      where: { jobId: id },
    });
    expect(Number(finance.customerDays)).toBe(5);
    expect(finance.totalClientPence).toBe(200_000);
  });

  it('holds the driver for every day of the block', async () => {
    // The failure this guards: the contract falls through to a one-hour
    // estimate, the driver looks free on the Wednesday, and somebody books
    // them onto an airport run they cannot do.
    await book();

    const midweek = await checkDriverConflicts(driverId, {
      scheduledAt: new Date('2026-07-29T14:00:00Z'),
      estimatedMinutes: 60,
    });
    expect(midweek.conflicts.length).toBeGreaterThan(0);
    expect(midweek.conflicts[0]?.overlapping).toBe(true);

    // …and is free again the following week.
    const after = await checkDriverConflicts(driverId, {
      scheduledAt: new Date('2026-08-04T14:00:00Z'),
      estimatedMinutes: 60,
    });
    expect(after.conflicts).toHaveLength(0);
  });

  it('bills as days on the invoice, not as one trip', async () => {
    const id = await book();
    await raw!.job.update({ where: { id }, data: { status: 'COMPLETED' } });

    const invoice = await createInvoice(
      {
        accountId,
        issueDate: new Date('2026-08-03'),
        lines: [{ description: 'Opening', amountPence: 0 }],
      },
      audit,
    );
    expect(invoice.ok).toBe(true);
    if (!invoice.ok) return;
    invoiceIds.push(invoice.id);

    expect((await addJobLine(invoice.id, id, audit)).ok).toBe(true);

    const line = await raw!.invoiceLine.findFirstOrThrow({
      where: { invoiceId: invoice.id, jobId: id },
    });
    expect(Number(line.quantity)).toBe(5);
    expect(line.quantityUnit).toBe('days');
    expect(line.unitPricePence).toBe(40_000);
    expect(line.amountPence).toBe(200_000);
    expect(line.description).toContain('Contract hire');
    // The block, not one date.
    expect(line.description).toMatch(/27 Jul(y)? 2026 to 31 Jul(y)? 2026/);
  });

  it('refuses a contract with no end', async () => {
    // Without one it is not a contract; nothing could say how many days to
    // bill or which days the car is spoken for.
    expect(() => form({ contractEndsOn: '' })).toThrow();
  });

  it('refuses an end before the start', async () => {
    expect(() => form({ contractEndsOn: '2026-07-20' })).toThrow();
  });

  it('refuses a day rate with no days, rather than billing nothing', async () => {
    expect(() => form({ customerDays: '' })).toThrow();
  });

  it('clears the block when a contract is changed to a transfer', async () => {
    // A stale end date on a job that is no longer a contract would go on
    // holding the car for a week.
    const id = await book();
    const { updateJob } = await import('./jobs');
    await updateJob(
      id,
      form({
        jobType: 'TRANSFER',
        contractEndsOn: '',
        customerDays: '',
        customerDayRatePence: '',
        driverDayRatePence: '',
        clientPricePence: '90.00',
      }),
      audit,
    );

    const job = await raw!.job.findUniqueOrThrow({ where: { id } });
    expect(job.contractEndsAt).toBeNull();
  });
});
