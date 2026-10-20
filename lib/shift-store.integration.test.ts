import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawPrismaClient } from './raw-prisma';
import { toLondon } from './dates';
import { paidMinutes } from './shifts';
import { openShift, recordShift } from './shift-store';

/**
 * Entering a shift that has already been worked, against a real database.
 *
 * The arithmetic and the rules are covered without a database in
 * `shifts.test.ts`. What only this can prove is the part that makes
 * backdating safe to offer at all: that the clash check actually finds the
 * shift it should, through a query, including the awkward case of an open
 * shift with no end for SQL to compare against.
 *
 * The stakes are a driver paid twice. A payout is built from shifts, so two
 * shifts covering the same Tuesday are two payments, and nothing downstream
 * notices — which is why this check has to exist before the feature does.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE ? rawPrismaClient(process.env.TEST_DATABASE_URL) : null;

const stamp = String(Date.now()).slice(-7);

/**
 * A wall-clock time a fortnight or so back, as the form would send it.
 *
 * Strings rather than Dates because that is what the store takes now: a
 * `datetime-local` input sends what somebody typed with no timezone on it,
 * and reading it as UTC is how an eight o'clock start came to be stored as
 * nine during British Summer Time.
 */
function at(day: number, hour: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 14 + day);
  return `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
}

describe.skipIf(!DATABASE_AVAILABLE)('recording a worked shift', () => {
  let driverId: string;
  const shiftIds: string[] = [];

  const base = {
    vehicleId: null,
    breakMinutes: 30,
    hourlyRatePence: 1800,
    notes: '',
  };

  beforeAll(async () => {
    if (!raw) throw new Error('no database');

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-${stamp}`,
        name: `Shift Tester ${stamp}`,
        phone: `07700 9${stamp.slice(-5)}`,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobFinance.deleteMany({ where: { job: { driverId } } });
    await raw.job.deleteMany({ where: { reference: { startsWith: `JOB-${stamp}-` } } });
    await raw.driverShift.deleteMany({ where: { driverId } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.$disconnect();
  });

  async function record(day: number, from: number, to: number) {
    const result = await recordShift(
      { ...base, driverId, startedAt: at(day, from), endedAt: at(day, to) },
      {},
    );
    if (result.ok) shiftIds.push(result.id);
    return result;
  }

  it('enters a shift worked last week, already closed', async () => {
    const result = await record(1, 8, 16);

    expect(result.ok).toBe(true);

    const shift = await raw!.driverShift.findUnique({
      where: { id: (result as { id: string }).id },
    });
    // Closed on arrival, which is the whole difference from clocking on.
    expect(shift?.endedAt).not.toBeNull();
    expect(shift?.approvedAt, 'recording is not approving').toBeNull();
  });

  it('refuses the same hours entered twice', async () => {
    // The same day entered again, which is what somebody does when they are
    // not sure whether they already did it.
    const again = await record(1, 8, 16);

    expect(again.ok).toBe(false);
    expect(again.ok === false && again.message).toMatch(/already covers/);
  });

  it('refuses a shift that merely overlaps one already there', async () => {
    const overlapping = await record(1, 14, 20);

    expect(overlapping.ok).toBe(false);
    expect(overlapping.ok === false && overlapping.message).toMatch(/already covers/);
  });

  it('allows one that starts where the last ended', async () => {
    // Handing a car over at the top of the hour is the normal case.
    const next = await record(1, 16, 20);

    expect(next.ok).toBe(true);
  });

  it('allows a different day', async () => {
    expect((await record(2, 8, 16)).ok).toBe(true);
  });

  it('records past work while the driver is clocked on right now', async () => {
    /*
     * The case that would make the feature useless if the one-open-shift rule
     * applied here. A driver on shift this afternoon may perfectly well have
     * worked a day last week that nobody entered.
     */
    // Six hours ago, so there is a stretch of it that is genuinely past and
    // can be tested against below.
    const open = await openShift(
      { ...base, driverId, startedAt: toLondon(new Date(Date.now() - 6 * 60 * 60 * 1000)) },
      {},
    );
    expect(open.ok).toBe(true);
    if (open.ok) shiftIds.push(open.id);

    const earlier = await record(3, 8, 16);
    expect(earlier.ok, 'last week should not collide with today').toBe(true);
  });

  it('refuses hours covered by the shift that is still open', async () => {
    /*
     * An open shift is treated as running on forever rather than up to now,
     * because those hours are still being counted. Anything starting after it
     * began would be paid twice.
     */
    const open = await raw!.driverShift.findFirst({
      where: { driverId, endedAt: null },
      select: { startedAt: true },
    });
    expect(open).not.toBeNull();

    // An hour inside the open shift, and finished — so the "not yet" check
    // cannot be what refuses it.
    const since = new Date(open!.startedAt.getTime() + 60 * 60 * 1000);
    const result = await recordShift(
      {
        ...base,
        driverId,
        startedAt: toLondon(since),
        endedAt: toLondon(new Date(since.getTime() + 60 * 60 * 1000)),
      },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/already covers/);
  });

  it('counts the real hours across the night the clocks change', async () => {
    /*
     * The case that proves the times are stored properly rather than
     * coincidentally. On 29 March 2026 the clocks went forward at one in the
     * morning, so midnight to four is three hours of actual work, not four.
     *
     * Reading a `datetime-local` value with `new Date()` takes it as UTC —
     * the server's zone on a deployment — which makes every British Summer
     * Time entry an hour out and this night's a whole hour of overpay. Both
     * ends shifting together hid it on an ordinary day; this is the day it
     * does not.
     */
    const result = await recordShift(
      {
        ...base,
        breakMinutes: 0,
        driverId,
        startedAt: '2026-03-29T00:00',
        endedAt: '2026-03-29T04:00',
      },
      {},
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const shift = await raw!.driverShift.findUniqueOrThrow({
      where: { id: result.id },
      select: { startedAt: true, endedAt: true },
    });

    // Midnight London that night is midnight UTC; four o'clock London is
    // three o'clock UTC, because an hour of the night did not happen.
    expect(shift.startedAt.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(shift.endedAt?.toISOString()).toBe('2026-03-29T03:00:00.000Z');

    expect(
      paidMinutes({ ...shift, breakMinutes: 0 }),
      'three hours worked, not four',
    ).toBe(180);
  });

  describe('the jobs worked during it', () => {
    /*
     * A shift entered after the fact covers work booked before the shift
     * existed, so nothing could have linked the two at the time. Without the
     * link every one of those jobs still carries its own driver fee, which is
     * then charged again as shift pay — the same day costed twice, in two
     * reports that disagree.
     */
    async function makeJob(input: {
      hour: number;
      day?: number;
      status?: string;
      driverPaymentPence?: number;
      shiftId?: string;
      assigned?: boolean;
    }) {
      const job = await raw!.job.create({
        data: {
          reference: `JOB-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
          jobType: 'TRANSFER',
          status: (input.status ?? 'COMPLETED') as never,
          scheduledAt: new Date(`${at(input.day ?? 6, input.hour)}:00Z`),
          pickupText: 'The Savoy',
          dropoffText: 'Heathrow T5',
          driverId: input.assigned === false ? null : driverId,
          shiftId: input.shiftId ?? null,
          clientPricePence: 20000,
          driverPricePence: input.driverPaymentPence ?? 0,
        },
        select: { id: true },
      });

      if (input.driverPaymentPence) {
        await raw!.jobFinance.create({
          data: {
            jobId: job.id,
            baseFarePence: 20000,
            driverPaymentPence: input.driverPaymentPence,
            totalClientPence: 20000,
            totalCostsPence: input.driverPaymentPence,
            grossProfitPence: 20000 - input.driverPaymentPence,
          },
        });
      }

      return job.id;
    }

    it('attaches the driver’s jobs from that stretch, and clears their driver cost', async () => {
      const inside = await makeJob({ hour: 10, driverPaymentPence: 8000 });
      const outside = await makeJob({ hour: 20, driverPaymentPence: 8000 });

      const result = await recordShift(
        { ...base, driverId, startedAt: at(6, 8), endedAt: at(6, 16) },
        {},
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const attached = await raw!.job.findUniqueOrThrow({
        where: { id: inside },
        select: { shiftId: true, finance: true },
      });
      expect(attached.shiftId).toBe(result.id);

      // The figure is not merely ignored downstream — it is cleared, and the
      // job's own profit recomputed. A number that is no longer counted but
      // still sitting in the panel is the worst of both readings.
      expect(attached.finance?.driverPaymentPence).toBe(0);
      expect(attached.finance?.grossProfitPence).toBe(20000);

      const untouched = await raw!.job.findUniqueOrThrow({
        where: { id: outside },
        select: { shiftId: true, finance: true },
      });
      expect(untouched.shiftId, 'eight in the evening is not in an 08:00–16:00 shift').toBeNull();
      expect(untouched.finance?.driverPaymentPence).toBe(8000);
    });

    it('leaves a job that is already on another shift alone', async () => {
      const earlier = await recordShift(
        { ...base, driverId, startedAt: at(7, 8), endedAt: at(7, 12) },
        {},
      );
      expect(earlier.ok).toBe(true);
      if (!earlier.ok) return;

      const spoken = await makeJob({ day: 7, hour: 13, shiftId: earlier.id });

      const later = await recordShift(
        { ...base, driverId, startedAt: at(7, 12), endedAt: at(7, 18) },
        {},
      );
      expect(later.ok).toBe(true);

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: spoken },
        select: { shiftId: true },
      });
      // Whoever put it there knew something, and moving work between two
      // drivers' pay is not a thing to do without being asked.
      expect(job.shiftId).toBe(earlier.id);
    });

    it('skips a job that was cancelled', async () => {
      const called_off = await makeJob({ day: 8, hour: 10, status: 'CANCELLED' });

      const result = await recordShift(
        { ...base, driverId, startedAt: at(8, 8), endedAt: at(8, 16) },
        {},
      );
      expect(result.ok).toBe(true);

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: called_off },
        select: { shiftId: true },
      });
      // A journey that did not happen was not worked, whatever the hours say.
      expect(job.shiftId).toBeNull();
    });

    it('skips a job nobody was assigned to', async () => {
      const unassigned = await makeJob({ day: 9, hour: 10, assigned: false });

      const result = await recordShift(
        { ...base, driverId, startedAt: at(9, 8), endedAt: at(9, 16) },
        {},
      );
      expect(result.ok).toBe(true);

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: unassigned },
        select: { shiftId: true },
      });
      expect(job.shiftId).toBeNull();
    });
  });

  it('pays the rate in force when the shift was worked, not today’s', async () => {
    /*
     * Why the rate is resolved at the start of the recorded shift. Entering
     * March's work in April has to pay March's rate, or backdating quietly
     * becomes a pay rise.
     */
    await raw!.driverEngagement.create({
      data: {
        driverId,
        kind: 'HIRED',
        effectiveFrom: new Date(`${at(0, 0)}:00Z`),
        hourlyRatePence: 1500,
      },
    });
    await raw!.driverEngagement.create({
      data: {
        driverId,
        kind: 'HIRED',
        effectiveFrom: new Date(`${at(10, 0)}:00Z`),
        hourlyRatePence: 2500,
      },
    });

    const result = await recordShift(
      {
        ...base,
        hourlyRatePence: null,
        driverId,
        startedAt: at(5, 8),
        endedAt: at(5, 12),
      },
      {},
    );

    expect(result.ok).toBe(true);
    const shift = await raw!.driverShift.findUnique({
      where: { id: (result as { id: string }).id },
      select: { hourlyRatePence: true },
    });
    expect(shift?.hourlyRatePence).toBe(1500);

    await raw!.driverEngagement.deleteMany({ where: { driverId } });
  });
});
