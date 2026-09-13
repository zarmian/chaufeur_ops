import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDriverConflicts } from './conflict-store';
import {
  contractSchema,
  createContract,
  cancelContractJobsFrom,
  endedAfter,
  generateAllContracts,
  generateContractJobs,
  reassignContractJobs,
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
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-7);

let driverId = '';
let coverDriverId = '';
let accountId = '';
/** The car the contract starts on, the one it moves to, and one with a lapsed MOT. */
let oldVehicleId = '';
let newVehicleId = '';
let lapsedVehicleId = '';
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
    const vehicle = (suffix: string, expiries: Date | null) => ({
      registration: `C${suffix}${stamp}`.slice(0, 12),
      normalisedRegistration: `C${suffix}${stamp}`.slice(0, 12),
      make: 'Mercedes-Benz',
      model: 'E-Class',
      motExpiry: expiries,
      insuranceExpiry: expiries,
      phvLicenceExpiry: expiries,
    });

    // Well clear of every date these tests use, so compliance is never the
    // accidental reason something did or did not move.
    const valid = new Date('2027-12-31');
    const lapsed = new Date('2026-01-01');

    const [driver, cover, account, oldCar, newCar, lapsedCar] = await Promise.all([
      raw.driver.create({
        data: {
          name: `Contract Driver ${stamp}`,
          phone: `07700 6${stamp}`,
          normalisedPhone: `77006${stamp}`,
          reference: `DRV-K${stamp}`,
          // Compliant, so that a day which does not move is never failing for
          // a reason the test did not set up.
          dvlaLicenceExpiry: valid,
          phvBadgeExpiry: valid,
        },
      }),
      raw.driver.create({
        data: {
          name: `Cover Driver ${stamp}`,
          phone: `07700 7${stamp}`,
          normalisedPhone: `77007${stamp}`,
          reference: `DRV-L${stamp}`,
          dvlaLicenceExpiry: valid,
          phvBadgeExpiry: valid,
        },
      }),
      raw.account.create({
        data: { name: `Contract Client ${stamp}`, kind: 'CORPORATE' },
      }),
      raw.vehicle.create({ data: vehicle('O', valid) }),
      raw.vehicle.create({ data: vehicle('N', valid) }),
      raw.vehicle.create({ data: vehicle('X', lapsed) }),
    ]);
    driverId = driver.id;
    coverDriverId = cover.id;
    accountId = account.id;
    oldVehicleId = oldCar.id;
    newVehicleId = newCar.id;
    lapsedVehicleId = lapsedCar.id;
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!raw) return;
    await cleanup();
    await raw.vehicle.deleteMany({
      where: { id: { in: [oldVehicleId, newVehicleId, lapsedVehicleId] } },
    });
    await raw.driver.deleteMany({ where: { id: { in: [driverId, coverDriverId] } } });
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

    await setContractActive(id, false, audit);
    const results = await generateAllContracts(audit, { today: '2026-08-10' });
    expect(results.some((row) => row.contractId === id)).toBe(false);
  });

  it('cancels the days still to come when the contract is stopped', async () => {
    /*
     * Changed behaviour, and the reason: leaving them standing made stopping a
     * half-action. The arrangement was over, the office believed it had ended
     * it, and a fortnight of days sat on the board waiting to send cars to a
     * client who had cancelled.
     *
     * `now` is pinned before the fixture week so its days count as upcoming,
     * the same trick the reassignment tests use.
     */
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });
    const booked = await raw!.job.count({ where: { contractId: id } });
    expect(booked).toBe(6);

    const result = await setContractActive(id, false, audit, {
      now: new Date('2026-07-20T09:00:00.000Z'),
    });

    expect(result.cancelled).toBe(6);
    expect(result.refused).toEqual([]);
    // Cancelled, not deleted. They are bookings that happened and then did
    // not, and the record of them is what answers "what did we tell them".
    expect(await raw!.job.count({ where: { contractId: id } })).toBe(booked);
    expect(
      await raw!.job.count({ where: { contractId: id, status: 'CANCELLED' } }),
    ).toBe(6);
  });

  it('leaves a day that has already run, and one already called off', async () => {
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });
    const [first, second] = await raw!.job.findMany({
      where: { contractId: id },
      orderBy: { scheduledAt: 'asc' },
      take: 2,
    });
    await raw!.job.update({
      where: { id: first!.id },
      data: { status: 'COMPLETED' },
    });
    await raw!.job.update({
      where: { id: second!.id },
      data: { status: 'CANCELLED' },
    });

    const result = await setContractActive(id, false, audit, {
      now: new Date('2026-07-20T09:00:00.000Z'),
    });

    // The four still to come. The completed day keeps its status — a contract
    // ending has no business in work that was already done and is billable.
    expect(result.cancelled).toBe(4);
    const after = await raw!.job.findUniqueOrThrow({ where: { id: first!.id } });
    expect(after.status).toBe('COMPLETED');
  });

  it('cancels nothing that is already in the past', async () => {
    // The default `now`. A contract stopped today must not reach back and
    // call off last month's work.
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });

    const result = await setContractActive(id, false, audit);

    expect(result).toEqual({ cancelled: 0, refused: [] });
    expect(
      await raw!.job.count({ where: { contractId: id, status: 'CANCELLED' } }),
    ).toBe(0);
  });

  it('cancels nothing when a contract is started again', async () => {
    // Restarting makes no days until the next run, so there is nothing to
    // undo — and un-cancelling days somebody has since dealt with is not
    // something this could get right.
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });

    const result = await setContractActive(id, true, audit, {
      now: new Date('2026-07-20T09:00:00.000Z'),
    });

    expect(result).toEqual({ cancelled: 0, refused: [] });
    expect(
      await raw!.job.count({ where: { contractId: id, status: 'CANCELLED' } }),
    ).toBe(0);
  });

  it('cancels the days beyond an end date brought forward', async () => {
    /*
     * The other way a contract ends: not stopped, but cut short. A client says
     * "we finish on the Wednesday" and the days already booked for Thursday
     * and Friday have to be called off, or a car turns up at the school gates
     * on the Thursday.
     */
    const id = await start();
    await generateContractJobs(id, audit, { today: MONDAY });

    const { previous } = await updateContract(
      id,
      form({ endsOn: '2026-07-29' }), // the Wednesday
      audit,
    );
    const from = endedAfter(
      previous.endsOn,
      new Date('2026-07-29T00:00:00.000Z'),
      'Europe/London',
    );
    expect(from).not.toBeNull();

    const result = await cancelContractJobsFrom(id, from!, audit);

    // Mon, Tue and Wed survive; Thu, Fri and the following Mon go.
    expect(result.cancelled).toBe(3);

    const standing = await raw!.job.findMany({
      where: { contractId: id, status: { not: 'CANCELLED' } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
    expect(standing).toHaveLength(3);
    // The Wednesday itself is kept — a day *on* the end date is a day the
    // contract owes, and in July its 07:45 pickup is 06:45 UTC.
    expect(standing[2]?.scheduledAt.toISOString()).toBe(
      '2026-07-29T06:45:00.000Z',
    );
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
  /**
   * Changing the car on a contract, and what happens to the days it made.
   *
   * The one place a contract edit reaches forward, and the one place these
   * tests are about real bookings rather than arithmetic: the wrong answer
   * here is a driver turning up in a car the client was not watching for, or
   * somebody's deliberate change to a single day being quietly undone.
   *
   * `now` is pinned before the fixture Monday so the days it generated count
   * as upcoming — the same reason the rest of this file pins `today`.
   */
  describe('moving the days onto a new car', () => {
    /** Before the fixture week, so every generated day is still ahead. */
    const BEFORE = new Date('2026-07-20T09:00:00.000Z');

    async function started(overrides: Record<string, unknown> = {}) {
      const id = await start({ vehicleId: oldVehicleId, ...overrides });
      await generateContractJobs(id, audit, { today: MONDAY });
      return id;
    }

    /** Swap the contract onto a different car, as the edit form would. */
    async function moveTo(
      id: string,
      vehicleId: string,
      overrides: Record<string, unknown> = {},
    ) {
      const { previous } = await updateContract(
        id,
        form({ vehicleId, ...overrides }),
        audit,
      );
      return reassignContractJobs(id, previous, audit, { now: BEFORE });
    }

    it('puts every upcoming day on the car now selected', async () => {
      const id = await started();
      const result = await moveTo(id, newVehicleId);

      expect(result.moved).toBe(6);
      expect(result.skipped).toEqual([]);

      const days = await raw!.job.findMany({
        where: { contractId: id },
        select: { vehicleId: true },
      });
      expect(days).toHaveLength(6);
      expect(days.every((day) => day.vehicleId === newVehicleId)).toBe(true);
    });

    it('leaves a day somebody had already put another car on, and names it', async () => {
      /*
       * The rule that will look wrong before it looks right. The usual car is
       * in for its MOT on the Wednesday, so that day was moved to the spare;
       * six weeks later the contract changes car permanently. Overwriting the
       * Wednesday would undo a decision made for a reason nothing here knows.
       */
      const id = await started();
      const wednesday = await raw!.job.findFirstOrThrow({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
        skip: 2,
      });
      await raw!.job.update({
        where: { id: wednesday.id },
        data: { vehicleId: lapsedVehicleId },
      });

      const result = await moveTo(id, newVehicleId);

      expect(result.moved).toBe(5);
      expect(result.skipped).toEqual([
        { reference: wednesday.reference, reason: 'its car was changed on the day itself' },
      ]);

      // Still on the car somebody chose for it.
      const after = await raw!.job.findUniqueOrThrow({ where: { id: wednesday.id } });
      expect(after.vehicleId).toBe(lapsedVehicleId);
    });

    it('refuses a car that cannot legally do the job, and says why', async () => {
      // A lapsed MOT does not become acceptable because it arrived through a
      // contract rather than the booking form.
      const id = await started();
      const result = await moveTo(id, lapsedVehicleId);

      expect(result.moved).toBe(0);
      expect(result.skipped).toHaveLength(6);
      expect(result.skipped[0]?.reason).toMatch(/MOT/i);

      const days = await raw!.job.findMany({
        where: { contractId: id },
        select: { vehicleId: true },
      });
      expect(days.every((day) => day.vehicleId === oldVehicleId)).toBe(true);
    });

    it('does not touch a day that has run or been called off', async () => {
      const id = await started();
      const [first, second] = await raw!.job.findMany({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
        take: 2,
      });
      await raw!.job.update({
        where: { id: first!.id },
        data: { status: 'COMPLETED' },
      });
      await raw!.job.update({
        where: { id: second!.id },
        data: { status: 'CANCELLED' },
      });

      const result = await moveTo(id, newVehicleId);

      expect(result.moved).toBe(4);
      // Settled days are not reported either — there is nothing for anybody
      // to do about a day that already happened.
      expect(result.skipped).toEqual([]);
      const settled = await raw!.job.findMany({
        where: { id: { in: [first!.id, second!.id] } },
        select: { vehicleId: true },
      });
      expect(settled.every((day) => day.vehicleId === oldVehicleId)).toBe(true);
    });

    it('moves the driver too, and drops an acceptance the new driver never gave', async () => {
      const id = await started();
      const days = await raw!.job.findMany({
        where: { contractId: id },
        orderBy: { scheduledAt: 'asc' },
      });
      await raw!.job.update({
        where: { id: days[0]!.id },
        data: { status: 'ACCEPTED' },
      });

      const result = await moveTo(id, oldVehicleId, { driverId: coverDriverId });
      expect(result.moved).toBe(6);

      const after = await raw!.job.findUniqueOrThrow({ where: { id: days[0]!.id } });
      expect(after.driverId).toBe(coverDriverId);
      // The new driver has accepted nothing.
      expect(after.status).toBe('ASSIGNED');
    });

    it('does nothing at all when the edit left the crew alone', async () => {
      // Saving a contract after correcting its notes must not write to a
      // single day, or every save becomes a message to every driver.
      const id = await started();
      const result = await moveTo(id, oldVehicleId, { notes: 'Gate code 4821' });

      expect(result).toEqual({ moved: 0, skipped: [] });
    });

    it('clears the car off the days when the contract clears it', async () => {
      const id = await started();
      const result = await moveTo(id, '');

      expect(result.moved).toBe(6);
      const days = await raw!.job.findMany({
        where: { contractId: id },
        select: { vehicleId: true },
      });
      expect(days.every((day) => day.vehicleId === null)).toBe(true);
    });
  });
});
