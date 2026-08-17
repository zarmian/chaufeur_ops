import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDriverConflicts } from './conflict-store';
import {
  contractSchema,
  createContract,
  generateAllContracts,
  generateContractJobs,
  repriceContractJobs,
  setContractActive,
  updateContract,
} from './contracts';
import { createJob, jobSchema } from './jobs';

/**
 * A standing contract, turned into days by the cron.
 *
 * The things only a database shows: that the days are ordinary priced jobs,
 * that running the cron twice does not book the same day twice, and that the
 * driver named on the contract is still free to do other work — which is the
 * whole point of it being an arrangement rather than a reservation.
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
const contractIds: string[] = [];
const invoiceIds: string[] = [];

/** A Monday, in summer, so a mishandled timezone shows as a day's drift. */
const MONDAY = '2026-07-27';

const form = (overrides: Record<string, unknown> = {}) =>
  contractSchema.parse({
    label: `School run ${stamp}`,
    accountId,
    pickupText: '21 York Terrace East',
    dropoffText: 'Highgate School',
    startTime: '07:45',
    startsOn: MONDAY,
    dayRatePence: '120.00',
    driverDayRatePence: '55.00',
    weekdays: [1, 2, 3, 4, 5],
    driverId,
    generateAheadDays: 7,
    ...overrides,
  });

async function cleanup() {
  if (!raw) return;
  const jobs = await raw.job.findMany({
    where: {
      OR: [
        { contractId: { in: contractIds } },
        { reference: { contains: `X${stamp}` } },
      ],
    },
    select: { id: true },
  });
  const ids = jobs.map((job) => job.id);
  await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await raw.invoiceLine.deleteMany({ where: { jobId: { in: ids } } });
  await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  invoiceIds.length = 0;
  await raw.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
  await raw.jobFinance.deleteMany({ where: { jobId: { in: ids } } });
  await raw.job.deleteMany({ where: { id: { in: ids } } });
  await raw.jobContract.deleteMany({ where: { id: { in: contractIds } } });
  contractIds.length = 0;
}

describe.skipIf(!DATABASE_AVAILABLE)('standing contracts', () => {
  beforeAll(async () => {
    if (!raw) return;
    const [driver, account] = await Promise.all([
      raw.driver.create({
        data: {
          name: `Contract Driver ${stamp}`,
          phone: `07700 6${stamp}`,
          normalisedPhone: `77006${stamp}`,
          reference: `DRV-K${stamp}`,
        },
      }),
      raw.account.create({
        data: { name: `Contract Client ${stamp}`, kind: 'CORPORATE' },
      }),
    ]);
    driverId = driver.id;
    accountId = account.id;
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!raw) return;
    await cleanup();
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.account.deleteMany({ where: { id: accountId } });
    await raw.$disconnect();
  });

  async function start(overrides: Record<string, unknown> = {}) {
    const created = await createContract(form(overrides), audit);
    contractIds.push(created.id);
    return created.id;
  }

  it('books a job for each day it runs, priced at the day rate', async () => {
    const id = await start();
    const result = await generateContractJobs(id, audit, { today: MONDAY });

    // Monday to Friday plus the following Monday: the horizon is seven days
    // and the weekend is skipped.
    expect(result.created).toHaveLength(6);

    const jobs = await raw!.job.findMany({
      where: { contractId: id },
      orderBy: { scheduledAt: 'asc' },
      include: { finance: true },
    });

    expect(jobs[0]?.jobType).toBe('CONTRACT');
    expect(jobs[0]?.driverId).toBe(driverId);
    // Priced at booking, so a contract day is never an unpriced job.
    expect(jobs[0]?.finance?.totalClientPence).toBe(12_000);
    expect(Number(jobs[0]?.finance?.customerDays)).toBe(1);
    expect(jobs[0]?.finance?.customerDayRatePence).toBe(12_000);
    expect(jobs[0]?.finance?.grossProfitPence).toBe(6500);

    // 07:45 local on the Monday, not 07:45 UTC — the pickup time is a wall
    // clock that repeats, and in July London is an hour ahead.
    expect(jobs[0]?.scheduledAt.toISOString()).toBe('2026-07-27T06:45:00.000Z');
  });

  it('creates nothing on a second run the same day', async () => {
    // The cron runs every night, and may run twice. Two cars at the school
    // gates is the failure this prevents.
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });
    const again = await generateContractJobs(id, audit, { today: MONDAY });

    expect(again.created).toEqual([]);
    expect(await raw!.job.count({ where: { contractId: id } })).toBe(6);
  });

  it('books nothing twice even if the watermark is moved back', async () => {
    // The watermark alone handles the ordinary case; the existence check is
    // what makes it safe when two runs overlap or somebody fills a gap.
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });
    await raw!.jobContract.update({
      where: { id },
      data: { generatedThroughOn: null },
    });

    const again = await generateContractJobs(id, audit, { today: MONDAY });
    expect(again.created).toEqual([]);
    expect(again.skipped.every((skip) => skip.reason === 'already booked')).toBe(true);
    expect(await raw!.job.count({ where: { contractId: id } })).toBe(6);
  });

  it('runs open-ended, with no end date', async () => {
    const id = await start({ endsOn: '' });
    const contract = await raw!.jobContract.findUniqueOrThrow({ where: { id } });
    expect(contract.endsOn).toBeNull();

    // …and keeps booking on the next run.
    await generateContractJobs(id, audit, { today: MONDAY });
    const later = await generateContractJobs(id, audit, { today: '2026-08-10' });
    expect(later.created.length).toBeGreaterThan(0);
  });

  it('leaves the driver free for other work', async () => {
    // The correction this was built for. A contract is a standing
    // arrangement; the driver does other jobs around it, and a permanent
    // clash warning on the board is one nobody can clear.
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });

    // An airport run at exactly the hour the contract occupies. Against an
    // ordinary job this would warn; against a contract day it must not.
    const clashes = await checkDriverConflicts(driverId, {
      scheduledAt: new Date('2026-07-27T06:45:00.000Z'),
      estimatedMinutes: 60,
    });
    expect(clashes.conflicts).toEqual([]);
    expect(clashes.warning).toBeNull();

    // …and the check is not simply switched off: an ordinary job at that
    // hour still clashes with another ordinary job.
    const ordinary = await createJob(
      jobSchema.parse({
        jobType: 'AIRPORT_TRANSFER',
        scheduledDate: MONDAY,
        scheduledTime: '07:45',
        pickupText: 'Heathrow Terminal 5',
        dropoffText: 'The Savoy',
        clientPricePence: '90.00',
        driverId,
        accountId,
      }),
      audit,
    );
    await raw!.job.update({
      where: { id: ordinary.id },
      data: { reference: `X${stamp}-1` },
    });

    const now = await checkDriverConflicts(driverId, {
      scheduledAt: new Date('2026-07-27T06:45:00.000Z'),
      estimatedMinutes: 60,
    });
    expect(now.conflicts).toHaveLength(1);
    expect(now.conflicts[0]?.reference).toBe(`X${stamp}-1`);
  });

  it('stops making days when the contract is stopped', async () => {
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });
    const before = await raw!.job.count({ where: { contractId: id } });

    await setContractActive(id, false, audit);
    const results = await generateAllContracts(audit, { today: '2026-08-10' });
    expect(results.some((row) => row.contractId === id)).toBe(false);

    // The days it already made stay: they are bookings a client expects.
    expect(await raw!.job.count({ where: { contractId: id } })).toBe(before);
  });

  it('does not reprice days it has already made', async () => {
    // A contract whose rate changes in March must not retrospectively
    // reprice February — those days were worked, and possibly invoiced.
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });

    await updateContract(id, form({ dayRatePence: '200.00' }), audit);

    const first = await raw!.job.findFirstOrThrow({
      where: { contractId: id },
      orderBy: { scheduledAt: 'asc' },
      include: { finance: true },
    });
    expect(first.finance?.totalClientPence).toBe(12_000);
  });

  describe('repricing days already booked', () => {
    /** A contract with its days booked, then moved to a new rate. */
    async function rerated(overrides: Record<string, unknown> = {}) {
      const id = await start();
      await generateContractJobs(id, audit, { today: MONDAY });
      await updateContract(id, form({ dayRatePence: '200.00', ...overrides }), audit);
      return id;
    }

    it('leaves everything alone by default', async () => {
      // The default has to stay the safe one: a rate agreed today applies to
      // work not yet done.
      const id = await rerated();
      const result = await repriceContractJobs(id, 'none', audit);
      expect(result.repriced).toBe(0);

      const jobs = await raw!.job.findMany({
        where: { contractId: id },
        include: { finance: true },
      });
      expect(jobs.every((job) => job.finance?.totalClientPence === 12_000)).toBe(true);
    });

    it('reprices every day when asked, back to the beginning', async () => {
      // What this was added for: a rate settled after the fact, over a month
      // of days that already exist.
      const id = await rerated();
      const result = await repriceContractJobs(id, 'all', audit, {
        now: new Date('2026-08-31T00:00:00Z'),
      });
      expect(result.repriced).toBe(6);
      expect(result.skipped).toEqual([]);

      const jobs = await raw!.job.findMany({
        where: { contractId: id },
        include: { finance: true },
      });
      expect(jobs.every((job) => job.finance?.totalClientPence === 20_000)).toBe(true);
    });

    it('reprices only what has not happened yet, on the narrower scope', async () => {
      const id = await rerated();
      // Standing on the Wednesday: Monday and Tuesday are done.
      const result = await repriceContractJobs(id, 'upcoming', audit, {
        now: new Date('2026-07-29T00:00:00Z'),
      });
      expect(result.repriced).toBe(4);

      const jobs = await raw!.job.findMany({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
        include: { finance: true },
      });
      // The Monday keeps what it was billed at.
      expect(jobs[0]?.finance?.totalClientPence).toBe(12_000);
      expect(jobs[5]?.finance?.totalClientPence).toBe(20_000);
    });

    it('never touches a day that has been invoiced, and says which', async () => {
      // The rule that must not bend. The client is holding a document with a
      // figure on it; changing the job underneath leaves the two disagreeing
      // with nothing to say which is right.
      const id = await rerated();
      const first = await raw!.job.findFirstOrThrow({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
      });
      const invoice = await raw!.invoice.create({
        data: {
          number: `CONREP${stamp}-1`,
          issueDate: new Date('2026-08-01'),
          dueDate: new Date('2026-08-15'),
          netPence: 12_000,
          vatPence: 2400,
          grossPence: 14_400,
          status: 'SENT',
          lines: {
            create: [
              { description: 'Contract day', amountPence: 12_000, jobId: first.id },
            ],
          },
        },
      });
      invoiceIds.push(invoice.id);

      const result = await repriceContractJobs(id, 'all', audit, {
        now: new Date('2026-08-31T00:00:00Z'),
      });
      expect(result.repriced).toBe(5);
      expect(result.skipped).toEqual([
        { reference: first.reference, reason: `on invoice ${invoice.number}` },
      ]);

      const after = await raw!.jobFinance.findUniqueOrThrow({
        where: { jobId: first.id },
      });
      expect(after.totalClientPence).toBe(12_000);
    });

    it('keeps everything else a day carried', async () => {
      // Waiting time and a car park were recorded against that day for their
      // own reasons. The day rate is the only figure being replaced.
      const id = await rerated();
      const first = await raw!.job.findFirstOrThrow({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
      });
      await raw!.jobFinance.update({
        where: { jobId: first.id },
        data: { waitTimePence: 1500, extraChargesPence: 750 },
      });

      await repriceContractJobs(id, 'all', audit, {
        now: new Date('2026-08-31T00:00:00Z'),
      });

      const after = await raw!.jobFinance.findUniqueOrThrow({
        where: { jobId: first.id },
      });
      expect(after.waitTimePence).toBe(1500);
      expect(after.extraChargesPence).toBe(750);
      // £200 day + £15 waiting + £7.50 extras.
      expect(after.totalClientPence).toBe(22_250);
    });

    it('moves the driver rate too, so profit stays right', async () => {
      const id = await start();
      await generateContractJobs(id, audit, { today: MONDAY });
      await updateContract(
        id,
        form({ dayRatePence: '200.00', driverDayRatePence: '90.00' }),
        audit,
      );

      await repriceContractJobs(id, 'all', audit, {
        now: new Date('2026-08-31T00:00:00Z'),
      });

      const after = await raw!.jobFinance.findFirstOrThrow({
        where: { job: { contractId: id } },
      });
      expect(after.totalCostsPence).toBe(9000);
      expect(after.grossProfitPence).toBe(11_000);
    });

    it('skips a cancelled day, which is not going to be billed', async () => {
      const id = await rerated();
      const first = await raw!.job.findFirstOrThrow({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
      });
      await raw!.job.update({
        where: { id: first.id },
        data: { status: 'CANCELLED' },
      });

      const result = await repriceContractJobs(id, 'all', audit, {
        now: new Date('2026-08-31T00:00:00Z'),
      });
      expect(result.repriced).toBe(5);
    });

    it('records who repriced each day', async () => {
      const id = await rerated();
      const first = await raw!.job.findFirstOrThrow({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
        include: { finance: true },
      });

      await repriceContractJobs(id, 'all', audit, {
        now: new Date('2026-08-31T00:00:00Z'),
      });

      const entry = await raw!.auditLog.findFirst({
        where: { entity: 'JobFinance', entityId: first.finance!.id },
        orderBy: { createdAt: 'desc' },
      });
      // Before and after, so "why did January change in March" has an answer.
      expect(JSON.stringify(entry?.before)).toContain('12000');
      expect(JSON.stringify(entry?.after)).toContain('20000');
    });
  });

  it('stops at an end date once one is set', async () => {
    const id = await start({ endsOn: '2026-07-29' });
    const result = await generateContractJobs(id, audit, { today: MONDAY });
    expect(result.created).toHaveLength(3); // Mon, Tue, Wed

    const later = await generateContractJobs(id, audit, { today: '2026-08-10' });
    expect(later.created).toEqual([]);
  });

  it('reports a day it could not book rather than stopping', async () => {
    // One bad day must not silently end the run. The report names it,
    // because a contract short of a Tuesday is a car that does not turn up.
    const id = await start();
    const result = await generateContractJobs(id, audit, { today: MONDAY });
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.reference).toMatch(/^CON-\d+$/);
  });
});
