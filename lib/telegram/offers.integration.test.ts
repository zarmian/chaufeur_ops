import { rawPrismaClient } from '../raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, eligibleDrivers, liveOfferCount, withdrawOffers } from './offers';

/**
 * Two drivers, one job, and one of them is wrong.
 *
 * Everything else about offering a job to several people is arrangement —
 * which phones ring, what the message says, which button appears. This file
 * exists for the one question that cannot be answered by reading the code:
 * **what the database does when two drivers tap Accept at the same instant.**
 *
 * Read-then-write would pass a unit test, pass code review, work in every
 * manual trial, and hand the same job to both drivers the first morning two
 * people are awake at 5am — with nobody finding out until the second one
 * arrives at a pickup that already has a car on it. So the claim is a single
 * conditional update, and the test that proves it has to run both claims
 * concurrently against real Postgres. There is no way to fake this one.
 *
 * The sending half is deliberately not tested here. It needs a bot token, and
 * with none configured every send returns "not configured" and every
 * assertion about it would pass whatever the code did — the same reasoning as
 * `ops-alerts.integration.test.ts`.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/** Far enough out that nothing expires between now and the pickup. */
const PICKUP = new Date(Date.now() + 48 * 60 * 60 * 1000);
const VALID_UNTIL = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
const LAPSED = new Date(Date.now() - 24 * 60 * 60 * 1000);

describe.skipIf(!DATABASE_AVAILABLE)('offering one job to several drivers', () => {
  const driverIds: string[] = [];
  const jobIds: string[] = [];
  let made = 0;

  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.auditLog.deleteMany({ where: { entityId: { in: jobIds } } });
    await raw.jobOffer.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driver.deleteMany({ where: { id: { in: driverIds } } });
    await raw.$disconnect();
  });

  async function makeDriver(
    options: {
      linked?: boolean;
      badgeExpiry?: Date;
      status?: string;
    } = {},
  ): Promise<string> {
    made += 1;
    const driver = await raw!.driver.create({
      data: {
        reference: `OF-${stamp}-${made}`,
        // Ordered by name in `eligibleDrivers`, so the suffix keeps the
        // ordering assertions stable.
        name: `Offer Driver ${stamp} ${String(made).padStart(3, '0')}`,
        phone: `07700${stamp}${made}`,
        status: (options.status ?? 'ACTIVE') as never,
        dvlaLicenceExpiry: VALID_UNTIL,
        phvBadgeExpiry: options.badgeExpiry ?? VALID_UNTIL,
        // A real chat id: an unlinked driver has nowhere to receive an offer.
        telegramChatId: options.linked === false ? null : BigInt(500_000 + made),
      },
    });
    driverIds.push(driver.id);
    return driver.id;
  }

  async function makeJob(): Promise<string> {
    made += 1;
    const job = await raw!.job.create({
      data: {
        reference: `OJ-${stamp}-${made}`,
        jobType: 'TRANSFER',
        status: 'PENDING',
        scheduledAt: PICKUP,
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow Terminal 5',
        clientPricePence: 14_500,
        driverPricePence: 9_000,
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  /** Offer without sending: the rows are what `claimJob` reads. */
  async function offerTo(jobId: string, drivers: string[]): Promise<void> {
    for (const driverId of drivers) {
      await raw!.jobOffer.create({ data: { jobId, driverId } });
    }
  }

  it('gives the job to exactly one of two drivers tapping at once', async () => {
    const jobId = await makeJob();
    const first = await makeDriver();
    const second = await makeDriver();
    await offerTo(jobId, [first, second]);

    /*
     * Both started before either finishes. `Promise.all` on two calls that
     * each open their own connection is as close to simultaneous as this can
     * get from one process, and it is enough: the window that matters is the
     * gap between reading `driverId` and writing it, which is milliseconds
     * wide and which both of these land inside.
     */
    const [a, b] = await Promise.all([
      claimJob(jobId, first),
      claimJob(jobId, second),
    ]);

    const won = [a, b].filter((outcome) => outcome.ok);
    const lost = [a, b].filter((outcome) => !outcome.ok);

    // The assertion the whole feature turns on.
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ ok: false, reason: 'taken' });

    const job = await raw!.job.findUnique({
      where: { id: jobId },
      select: { driverId: true, status: true },
    });
    expect(job?.status).toBe('ACCEPTED');
    // And the driver on it is one of the two, not null and not a mixture.
    expect([first, second]).toContain(job?.driverId);
  });

  it('leaves the loser nothing to do and the winner an assignment', async () => {
    const jobId = await makeJob();
    const first = await makeDriver();
    const second = await makeDriver();
    await offerTo(jobId, [first, second]);

    await claimJob(jobId, first);
    const late = await claimJob(jobId, second);

    expect(late).toMatchObject({ ok: false, reason: 'taken' });

    const offers = await raw!.jobOffer.findMany({
      where: { jobId },
      select: { driverId: true, outcome: true, closedAt: true },
    });
    // Both closed: a live offer on a job that is being driven is an Accept
    // button somebody will press.
    expect(offers.every((offer) => offer.closedAt !== null)).toBe(true);
    expect(offers.find((offer) => offer.driverId === first)?.outcome).toBe('accepted');
    expect(offers.find((offer) => offer.driverId === second)?.outcome).toBe('taken');

    const events = await raw!.jobEvent.findMany({
      where: { jobId },
      select: { type: true, actorType: true, actorId: true },
    });
    expect(events.map((event) => event.type).sort()).toEqual(['ACCEPTED', 'ASSIGNED']);
    // Attributed to the driver, not to whoever last touched the job in the
    // office — nobody in the office touched it.
    expect(events.every((event) => event.actorType === 'DRIVER')).toBe(true);
    expect(events.every((event) => event.actorId === first)).toBe(true);
  });

  it('records the claim in the audit log, since no user made it', async () => {
    /*
     * Every other way a job acquires a driver is attributed to whoever
     * clicked. This one has nobody in the office in it, so without a row the
     * log shows a job that assigned itself.
     */
    const jobId = await makeJob();
    const driverId = await makeDriver();
    await offerTo(jobId, [driverId]);

    await claimJob(jobId, driverId);

    const entries = await raw!.auditLog.findMany({
      where: { entity: 'Job', entityId: jobId },
      select: { action: true, userId: true, after: true },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('update');
    // Drivers are not users, so no user is borrowed for the attribution.
    expect(entries[0]?.userId).toBeNull();
    expect(entries[0]?.after).toMatchObject({ driverId });
  });

  it('refuses a driver whose badge lapsed after the offer went out', async () => {
    /*
     * The reason compliance is re-checked at the moment of accepting rather
     * than only when the offer was sent. An offer can sit unanswered
     * overnight, and driving on a lapsed PHV badge is a licensing breach, not
     * a preference — so the job must stay unassigned rather than go to
     * somebody who was eligible yesterday.
     */
    const jobId = await makeJob();
    const driverId = await makeDriver({ badgeExpiry: LAPSED });
    await offerTo(jobId, [driverId]);

    const outcome = await claimJob(jobId, driverId);
    expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });

    const job = await raw!.job.findUnique({
      where: { id: jobId },
      select: { driverId: true, status: true },
    });
    // Not even briefly theirs.
    expect(job?.driverId).toBeNull();
    expect(job?.status).toBe('PENDING');
  });

  it('refuses a driver the job was never offered to', async () => {
    // Callback data is sent by the client. A job id pasted into a button by
    // somebody else's phone must not be claimable.
    const jobId = await makeJob();
    const offered = await makeDriver();
    const stranger = await makeDriver();
    await offerTo(jobId, [offered]);

    expect(await claimJob(jobId, stranger)).toMatchObject({
      ok: false,
      reason: 'not offered',
    });

    const job = await raw!.job.findUnique({
      where: { id: jobId },
      select: { driverId: true },
    });
    expect(job?.driverId).toBeNull();
  });

  describe('who gets asked', () => {
    it('leaves out the unlinked, the inactive and the non-compliant', async () => {
      const jobId = await makeJob();
      const good = await makeDriver();
      const unlinked = await makeDriver({ linked: false });
      const inactive = await makeDriver({ status: 'INACTIVE' });
      const lapsed = await makeDriver({ badgeExpiry: LAPSED });

      const { eligible, skipped } = await eligibleDrivers(jobId, 500);
      const ids = eligible.map((driver) => driver.id);

      expect(ids).toContain(good);
      // No chat to send to — the offer *is* a Telegram message.
      expect(ids).not.toContain(unlinked);
      expect(ids).not.toContain(inactive);
      expect(ids).not.toContain(lapsed);

      // And the compliance refusal is reported rather than swallowed: an
      // "offered to 3 drivers" with no explanation looks like a broken
      // feature, where "17 skipped on compliance" is a morning's chasing.
      const reason = skipped.find((entry) => entry.driverId === lapsed);
      expect(reason?.reason).toMatch(/badge/i);

      /*
       * An unlinked driver is *not* in `skipped`, deliberately. That list is
       * what the office is shown after a broadcast, and filling it with every
       * driver who has never linked Telegram — most of a 195-driver fleet, on
       * every single offer — would bury the handful with a real document
       * problem, which is the half somebody can act on.
       */
      expect(skipped.map((entry) => entry.driverId)).not.toContain(unlinked);
    });

    it('stops at the limit rather than ringing the whole fleet', async () => {
      const jobId = await makeJob();
      await makeDriver();
      await makeDriver();
      await makeDriver();

      const { eligible } = await eligibleDrivers(jobId, 2);
      expect(eligible).toHaveLength(2);
    });
  });

  it('withdraws every live offer and counts what is still out', async () => {
    const jobId = await makeJob();
    const one = await makeDriver();
    const two = await makeDriver();
    await offerTo(jobId, [one, two]);

    expect(await liveOfferCount(jobId)).toBe(2);

    const { withdrawn } = await withdrawOffers(jobId);
    expect(withdrawn).toBe(2);
    expect(await liveOfferCount(jobId)).toBe(0);

    const outcomes = await raw!.jobOffer.findMany({
      where: { jobId },
      select: { outcome: true },
    });
    expect(outcomes.every((offer) => offer.outcome === 'withdrawn')).toBe(true);

    // Idempotent: withdrawing twice is not two withdrawals, and the job
    // screen's button can be pressed twice by anybody.
    expect((await withdrawOffers(jobId)).withdrawn).toBe(0);
  });
});
