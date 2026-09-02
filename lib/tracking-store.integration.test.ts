import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rawPrismaClient } from './raw-prisma';
import {
  issueTrackingToken,
  reissueTrackingToken,
  resolveTracking,
} from './tracking-store';

/**
 * Issuing and redeeming a link that anybody holding the URL can open.
 *
 * What the page *says* is decided in `lib/tracking.ts` and tested there
 * without a database. What only real rows can show is the part that governs
 * access: that a token is stable once issued, that reissuing takes the old
 * one away, and that every way of not being allowed in produces the same
 * answer — because a page that distinguishes "no such token" from "expired"
 * tells somebody guessing whether they guessed a real one.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

describe.skipIf(!DATABASE_AVAILABLE)('passenger tracking links', () => {
  const jobIds: string[] = [];
  let driverId = '';
  let made = 0;

  beforeAll(async () => {
    if (!raw) return;
    const driver = await raw.driver.create({
      data: {
        reference: `TRD-${stamp}`,
        name: `Marek Tracking ${stamp}`,
        phone: `07700${stamp}9`,
        status: 'ACTIVE',
      },
    });
    driverId = driver.id;
  });

  afterEach(async () => {
    if (!raw) return;
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    jobIds.length = 0;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.$disconnect();
  });

  async function makeJob(over: Record<string, unknown> = {}): Promise<string> {
    made += 1;
    const job = await raw!.job.create({
      data: {
        reference: `TR-${stamp}-${made}`,
        jobType: 'AIRPORT_TRANSFER',
        status: 'ASSIGNED',
        // An hour out, comfortably inside the link's window.
        scheduledAt: new Date(Date.now() + 3_600_000),
        pickupText: 'Heathrow Terminal 5',
        dropoffText: 'The Dorchester',
        clientPricePence: 14_500,
        driverPricePence: 9_000,
        // A driver on it, because "assigned with nobody assigned" is a state
        // that should not exist and the view reads the driver, not the
        // status column.
        driverId,
        ...over,
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  it('issues a token once and then keeps returning the same one', async () => {
    /*
     * Stability is the whole point. A passenger who saved the link the night
     * before must still have a working page in the morning, and re-sending
     * the booking confirmation must not invalidate what they are holding.
     */
    const jobId = await makeJob();

    const first = await issueTrackingToken(jobId);
    const second = await issueTrackingToken(jobId);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(first!.length).toBeGreaterThan(20);
  });

  it('refuses a draft, which nobody is being met off', async () => {
    expect(
      await issueTrackingToken(await makeJob({ status: 'DRAFT' })),
    ).toBeNull();
  });

  it('says a car is booked before a driver is on it', async () => {
    const jobId = await makeJob({ status: 'PENDING', driverId: null });
    const token = await issueTrackingToken(jobId);

    const page = await resolveTracking(token!);
    expect(page?.view.stage).toBe('BOOKED');
    expect(page?.view.driverName).toBeNull();
  });

  it('opens the page for a live link', async () => {
    const jobId = await makeJob();
    const token = await issueTrackingToken(jobId);

    const page = await resolveTracking(token!);

    expect(page).not.toBeNull();
    expect(page?.view.stage).toBe('ASSIGNED');
    expect(page?.view.driverName).toContain('Marek Tracking');
    expect(page?.pickupText).toBe('Heathrow Terminal 5');
  });

  it('takes the old link away when a new one is issued', async () => {
    // The reason the token is a column and not a signature: a link forwarded
    // to the wrong person has to be revocable on its own.
    const jobId = await makeJob();
    const original = await issueTrackingToken(jobId);
    const replacement = await reissueTrackingToken(jobId);

    expect(replacement).not.toBe(original);
    expect(await resolveTracking(original!)).toBeNull();
    expect(await resolveTracking(replacement!)).not.toBeNull();
  });

  it('answers the same way for a made-up token as for a revoked one', async () => {
    /*
     * Both null, and the page shows one 404 for either. Distinguishing them
     * is what would let somebody working through guesses learn that a token
     * exists but has been retired.
     */
    const jobId = await makeJob();
    const revoked = await issueTrackingToken(jobId);
    await reissueTrackingToken(jobId);

    expect(await resolveTracking(revoked!)).toBeNull();
    expect(await resolveTracking('this-was-never-a-token')).toBeNull();
    expect(await resolveTracking('')).toBeNull();
  });

  it('goes quiet once the journey is well past', async () => {
    // A link left in a group chat should stop being a page naming a driver,
    // a car and two addresses.
    const jobId = await makeJob({
      scheduledAt: new Date(Date.now() - 48 * 3_600_000),
    });
    const token = await issueTrackingToken(jobId);

    expect(await resolveTracking(token!)).toBeNull();
  });

  it('reads the driver’s own events, not just the job status', async () => {
    const jobId = await makeJob({ status: 'IN_PROGRESS' });
    const token = await issueTrackingToken(jobId);

    await raw!.jobEvent.create({
      data: {
        jobId,
        type: 'ON_WAY',
        actorType: 'DRIVER',
        occurredAt: new Date(),
      },
    });
    expect((await resolveTracking(token!))?.view.stage).toBe('ON_WAY');

    await raw!.jobEvent.create({
      data: {
        jobId,
        type: 'ARRIVED',
        actorType: 'DRIVER',
        occurredAt: new Date(),
      },
    });
    expect((await resolveTracking(token!))?.view.stage).toBe('ARRIVED');
  });

  it('stops answering for a job that has been deleted', async () => {
    const jobId = await makeJob();
    const token = await issueTrackingToken(jobId);

    await raw!.job.update({
      where: { id: jobId },
      data: { deletedAt: new Date() },
    });

    // Soft delete is filtered by the Prisma extension, so the link falls
    // through the same "no" as every other refusal.
    expect(await resolveTracking(token!)).toBeNull();
  });
});
