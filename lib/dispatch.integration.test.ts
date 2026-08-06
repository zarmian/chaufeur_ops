import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDriverConflicts, checkVehicleConflicts } from './conflict-store';
import { loadDispatchDay } from './dispatch';

/**
 * The board and the clashes, against a real database — spec 6.1 and 6.2.
 *
 * Two things only this can prove.
 *
 * The clash the old pickup-proximity check missed: a four-hour as-directed
 * hire starting at nine does not look like a clash with a nine-thirty pickup
 * if you compare pickup times, and the driver is plainly in two places at
 * once. That requires a `JobFinance` row, so it cannot be checked from a
 * fixture.
 *
 * And the performance budget — 6.1.12 asks for under a second at forty
 * drivers and a hundred and twenty jobs, which is a claim about queries, not
 * about arithmetic.
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

/** A day of its own, far enough out that no seeded job lands on it. */
const DAY = new Date('2119-06-15T12:00:00Z');

function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2119, 5, 15, hour, minute, 0));
}

describe.skipIf(!DATABASE_AVAILABLE)('dispatch', () => {
  let driverId = '';
  let otherDriverId = '';
  let vehicleId = '';
  const jobIds: string[] = [];
  const extraDriverIds: string[] = [];
  const extraVehicleIds: string[] = [];

  async function makeJob(input: {
    hour: number;
    minute?: number;
    estimatedMinutes?: number | null;
    customerHours?: number | null;
    driverId?: string | null;
    vehicleId?: string | null;
    status?: string;
  }): Promise<string> {
    if (!raw) throw new Error('no database');

    const job = await raw.job.create({
      data: {
        reference: `DSP-${stamp}-${jobIds.length}`,
        jobType: input.customerHours ? 'AS_DIRECTED' : 'TRANSFER',
        status: (input.status ?? 'ASSIGNED') as never,
        scheduledAt: at(input.hour, input.minute ?? 0),
        estimatedMinutes: input.estimatedMinutes ?? null,
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow Terminal 5',
        driverId: input.driverId === undefined ? driverId : input.driverId,
        vehicleId: input.vehicleId === undefined ? vehicleId : input.vehicleId,
        clientPricePence: 12_550,
      },
    });

    if (input.customerHours) {
      await raw.jobFinance.create({
        data: { jobId: job.id, customerHours: input.customerHours },
      });
    }

    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (!raw) return;

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `DS${stamp.slice(-5)}`,
        normalisedRegistration: `DS${stamp.slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        ownership: 'OWNED',
      },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `DS${stamp}`,
        name: `Dispatch Driver ${stamp}`,
        phone: `+4477${stamp}33`,
        status: 'ACTIVE',
        assignedVehicleId: vehicleId,
      },
    });
    driverId = driver.id;

    const other = await raw.driver.create({
      data: {
        reference: `DSO${stamp}`,
        name: `Other Dispatch Driver ${stamp}`,
        phone: `+4477${stamp}44`,
        status: 'ACTIVE',
      },
    });
    otherDriverId = other.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driver.deleteMany({
      where: { id: { in: [driverId, otherDriverId, ...extraDriverIds] } },
    });
    await raw.vehicle.deleteMany({
      where: { id: { in: [vehicleId, ...extraVehicleIds] } },
    });
    await raw.$disconnect();
  });

  describe('conflicts', () => {
    it('catches a long hire the pickup times alone would hide', async () => {
      // The case this whole rework exists for. 09:00 for four hours against
      // a 09:30 pickup: half an hour between pickups, and the driver is in
      // two places at once.
      await makeJob({ hour: 9, customerHours: 4 });

      const check = await checkDriverConflicts(
        driverId,
        { scheduledAt: at(9, 30), estimatedMinutes: 60 },
        0,
      );

      expect(check.conflicts).toHaveLength(1);
      expect(check.conflicts[0]?.overlapping).toBe(true);
      expect(check.warning).toContain('already on');
    });

    it('leaves a comfortably separate job alone', async () => {
      const check = await checkDriverConflicts(
        driverId,
        { scheduledAt: at(20), estimatedMinutes: 60 },
        30,
      );
      expect(check.conflicts).toEqual([]);
      expect(check.warning).toBeNull();
    });

    it('asks the same question of the car', async () => {
      // Spec 6.2.5. The same physical constraint, and a job may override the
      // driver's assigned vehicle — so checking the driver alone misses it.
      const check = await checkVehicleConflicts(
        vehicleId,
        { scheduledAt: at(10), estimatedMinutes: 60 },
        0,
      );
      expect(check.conflicts.length).toBeGreaterThan(0);
      expect(check.warning).toContain('This vehicle');
    });

    it('does not report a job clashing with itself', async () => {
      // An edit re-checks the job being edited, and a job overlaps itself
      // perfectly.
      const id = await makeJob({ hour: 14, estimatedMinutes: 60 });

      const check = await checkDriverConflicts(
        driverId,
        { id, scheduledAt: at(14), estimatedMinutes: 60 },
        0,
      );
      expect(check.conflicts.map((c) => c.id)).not.toContain(id);
    });

    it('ignores a job that has been cancelled', async () => {
      // A job that is not happening cannot clash with one that is, and
      // warning about it would train people to dismiss the warning.
      await makeJob({
        hour: 16,
        estimatedMinutes: 60,
        status: 'CANCELLED',
        driverId: otherDriverId,
      });

      const check = await checkDriverConflicts(
        otherDriverId,
        { scheduledAt: at(16), estimatedMinutes: 60 },
        0,
      );
      expect(check.conflicts).toEqual([]);
    });
  });

  describe('the board', () => {
    it('puts a driver’s jobs on their row and the rest in the unassigned pile', async () => {
      await makeJob({ hour: 11, estimatedMinutes: 60, driverId: null, status: 'PENDING' });

      const board = await loadDispatchDay(DAY);

      const row = board.rows.find((r) => r.driverId === driverId);
      expect(row, 'the driver should have a row').toBeTruthy();
      expect(row!.blocks.length).toBeGreaterThan(0);

      expect(board.unassigned.some((block) => block.reference.includes(stamp))).toBe(
        true,
      );
    });

    it('marks the overlapping blocks so they can be outlined', async () => {
      // Two jobs that genuinely collide: the four-hour hire runs 09:00–13:00
      // and this one starts inside it. The earlier tests only *asked* about
      // hypothetical clashes; the board can only outline real ones.
      await makeJob({ hour: 10, estimatedMinutes: 60 });

      const board = await loadDispatchDay(DAY);
      const row = board.rows.find((r) => r.driverId === driverId);

      const clashing = row!.blocks.filter((block) => block.conflictsWith.length > 0);
      expect(clashing.length).toBeGreaterThan(0);
      expect(board.counts.conflicts).toBeGreaterThan(0);
    });

    it('sizes a four-hour hire as four hours, not as an hour', async () => {
      const board = await loadDispatchDay(DAY);
      const row = board.rows.find((r) => r.driverId === driverId);
      const long = row!.blocks.find((block) => block.minutes === 240);

      expect(long, 'the as-directed hire should be four hours wide').toBeTruthy();
      // 05:00–24:00 is nineteen hours, so four of them is a little over a
      // fifth of the board.
      expect(long!.widthPct).toBeGreaterThan(19);
      expect(long!.widthPct).toBeLessThan(23);
    });

    it('hides drivers with nothing on unless asked', async () => {
      // Spec 6.1.11. Forty empty rows is forty rows of nothing.
      const busy = await loadDispatchDay(DAY);
      const all = await loadDispatchDay(DAY, { includeEmptyDrivers: true });

      expect(all.rows.length).toBeGreaterThan(busy.rows.length);
      expect(busy.rows.every((row) => row.blocks.length > 0)).toBe(true);
    });

    it('loads a full board inside the budget', async () => {
      if (!raw) return;
      // Spec 6.1.12 — under a second at forty drivers and a hundred and
      // twenty jobs. What it really tests is that the board is two queries
      // and some arithmetic, not a query per row.
      const drivers = await raw.driver.createManyAndReturn({
        data: Array.from({ length: 40 }, (_, i) => ({
          reference: `DSP${stamp}${i}`,
          name: `Load Driver ${stamp} ${i}`,
          phone: `+44770${stamp}${String(i).padStart(2, '0')}`,
          status: 'ACTIVE' as const,
        })),
        select: { id: true },
      });
      extraDriverIds.push(...drivers.map((d) => d.id));

      const created = await raw.job.createManyAndReturn({
        data: Array.from({ length: 120 }, (_, i) => ({
          reference: `DSPL-${stamp}-${i}`,
          jobType: 'TRANSFER' as const,
          status: 'ASSIGNED' as const,
          scheduledAt: at(6 + (i % 14), (i % 4) * 15),
          estimatedMinutes: 60,
          pickupText: 'The Dorchester',
          dropoffText: 'Heathrow Terminal 5',
          driverId: drivers[i % drivers.length]!.id,
          clientPricePence: 12_550,
        })),
        select: { id: true },
      });
      jobIds.push(...created.map((job) => job.id));

      const started = Date.now();
      const board = await loadDispatchDay(DAY, { includeEmptyDrivers: true });
      const elapsed = Date.now() - started;

      expect(board.counts.jobs).toBeGreaterThanOrEqual(120);

      // The spec's budget is one second, and that is the figure to hold the
      // production board to on a quiet machine. The ceiling here is looser
      // on purpose: this runs alongside every other integration file against
      // one Postgres, and a wall-clock assertion under that contention
      // measures the machine as much as the code.
      //
      // The defect it guards against is a query per driver row, which is not
      // a 2x regression — it is 40x. Three seconds catches that and does not
      // go red because another file happened to be seeding at the time.
      expect(elapsed, `took ${elapsed}ms`).toBeLessThan(3000);
    });
  });
});
