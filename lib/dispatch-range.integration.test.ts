import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDispatchRange } from './dispatch';

/**
 * The multi-day board, against a real database.
 *
 * The rules themselves are covered without a database in
 * `dispatch-attention.test.ts` and `job-progress.test.ts`. What only this can
 * prove is that they are wired to real rows: that a job lands in the right
 * *local* day, that the milestone events are actually read, and that a day
 * with nothing on it still gets a section rather than silently vanishing from
 * a board whose whole purpose is showing the week.
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

/**
 * A century of its own.
 *
 * `dispatch.integration.test.ts` reserves 2117 and `reports` reserves 2119,
 * for a reason documented at length in the first of those: Vitest runs files
 * in parallel, and fixtures that share a year leak into each other's totals
 * in a way that only fails under a scheduling race.
 */
const YEAR = 2115;

/** Mid-June, so the configured London zone is on British Summer Time. */
const START = new Date(`${YEAR}-06-15T12:00:00Z`);

/** A UTC instant. June in London is UTC+1, so 22:30Z is 23:30 local. */
function utc(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(YEAR, 5, day, hour, minute, 0));
}

describe.skipIf(!DATABASE_AVAILABLE)('the dispatch range', () => {
  let driverId = '';
  let vehicleId = '';
  const jobIds: string[] = [];

  async function makeJob(input: {
    at: Date;
    driverId?: string | null;
    status?: string;
    estimatedMinutes?: number | null;
    events?: { type: string; at: Date }[];
  }): Promise<string> {
    if (!raw) throw new Error('no database');

    const job = await raw.job.create({
      data: {
        reference: `RNG-${stamp}-${jobIds.length}`,
        jobType: 'TRANSFER',
        status: (input.status ?? 'PENDING') as never,
        scheduledAt: input.at,
        estimatedMinutes: input.estimatedMinutes ?? 60,
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow Terminal 5',
        driverId: input.driverId === undefined ? null : input.driverId,
        clientPricePence: 12_550,
      },
    });

    for (const event of input.events ?? []) {
      await raw.jobEvent.create({
        data: {
          jobId: job.id,
          type: event.type as never,
          actorType: 'DRIVER',
          occurredAt: event.at,
        },
      });
    }

    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (!raw) return;

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `RG${stamp.slice(-5)}`,
        normalisedRegistration: `RG${stamp.slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        ownership: 'OWNED',
      },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `RG${stamp}`,
        name: `Range Driver ${stamp}`,
        phone: `+4477${stamp}55`,
        status: 'ACTIVE',
        assignedVehicleId: vehicleId,
      },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  /** Only this test file's jobs — the scratch database has plenty of others. */
  const mine = <T extends { reference: string }>(jobs: T[]): T[] =>
    jobs.filter((job) => job.reference.startsWith(`RNG-${stamp}-`));

  it('gives every day in the range a section, including the empty ones', async () => {
    const range = await loadDispatchRange(START, { days: 4, now: utc(15, 8) });

    expect(range.days).toHaveLength(4);
    expect(range.days.map((day) => day.date)).toEqual([
      `${YEAR}-06-15`,
      `${YEAR}-06-16`,
      `${YEAR}-06-17`,
      `${YEAR}-06-18`,
    ]);
  });

  it('files a late-evening summer job under the day it is actually on', async () => {
    /*
     * The bucketing test that matters. 22:30 UTC in June is 23:30 in London,
     * so this job belongs to the 15th — but anything that reads the UTC date,
     * or formats and slices by position, files it under the 16th and the
     * dispatcher looking at Monday's board never sees Sunday's last airport
     * run. This is the British Summer Time defect the UTC-storage rule exists
     * to prevent, in the one place it is easiest to reintroduce.
     */
    await makeJob({ at: utc(15, 22, 30) });

    const range = await loadDispatchRange(START, { days: 4, now: utc(15, 8) });
    const fifteenth = range.days.find((day) => day.date === `${YEAR}-06-15`);
    const sixteenth = range.days.find((day) => day.date === `${YEAR}-06-16`);

    expect(mine(fifteenth!.jobs)).toHaveLength(1);
    expect(mine(sixteenth!.jobs)).toHaveLength(0);
    // And it is shown as the local time, not the stored one.
    expect(mine(fifteenth!.jobs)[0]).toMatchObject({ startLabel: '23:30' });
  });

  it('spreads work across the days it is booked on', async () => {
    await makeJob({ at: utc(16, 9) });
    await makeJob({ at: utc(17, 9) });
    await makeJob({ at: utc(17, 14) });

    const range = await loadDispatchRange(START, { days: 4, now: utc(15, 8) });
    const counts = range.days.map((day) => mine(day.jobs).length);

    // The 15th still has the late one from the test above.
    expect(counts).toEqual([1, 1, 2, 0]);
  });

  it('flags an unassigned job as its pickup approaches, and not before', async () => {
    const soon = await makeJob({ at: utc(15, 10) });

    // Six hours out, with a four-hour window: not yet a problem.
    const early = await loadDispatchRange(START, { days: 1, now: utc(15, 4) });
    expect(early.attention.map((item) => item.jobId)).not.toContain(soon);

    // Two hours out: it is.
    const late = await loadDispatchRange(START, { days: 1, now: utc(15, 8) });
    const item = late.attention.find((entry) => entry.jobId === soon);
    expect(item).toMatchObject({ reason: 'UNASSIGNED', severity: 'warning' });
    expect(item!.when).toBe('in 2h');
  });

  it('reads the driver events, so a driver on the way is left alone', async () => {
    /*
     * Both of these are `ASSIGNED` with a pickup an hour gone. The status
     * column cannot tell them apart; the events can, and only one of them
     * needs somebody to pick up the phone.
     */
    const silent = await makeJob({
      at: utc(15, 7),
      driverId,
      status: 'ASSIGNED',
    });
    const moving = await makeJob({
      at: utc(15, 7),
      driverId,
      status: 'ASSIGNED',
      events: [
        { type: 'ASSIGNED', at: utc(15, 5) },
        { type: 'ON_WAY', at: utc(15, 7, 30) },
      ],
    });

    const range = await loadDispatchRange(START, { days: 1, now: utc(15, 8) });
    const flagged = range.attention.map((item) => item.jobId);

    expect(flagged).toContain(silent);
    expect(flagged).not.toContain(moving);

    // And the board says where the moving one has got to.
    const row = mine(range.days[0]!.jobs).find((job) => job.id === moving);
    expect(row).toMatchObject({ progressLabel: 'On the way' });
  });

  it('counts the range as a whole as well as day by day', async () => {
    const range = await loadDispatchRange(START, { days: 4, now: utc(15, 8) });
    const dayTotal = range.days.reduce((sum, day) => sum + day.counts.jobs, 0);
    expect(range.totals.jobs).toBe(dayTotal);
  });

  it('offers the drivers a job can be given to', async () => {
    const range = await loadDispatchRange(START, { days: 1, now: utc(15, 8) });
    expect(range.drivers.map((driver) => driver.id)).toContain(driverId);
  });
});
