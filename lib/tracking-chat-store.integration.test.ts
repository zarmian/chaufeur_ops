import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rawPrismaClient } from './raw-prisma';
import { postFromDriver, postFromPassenger, threadFor } from './tracking-chat-store';

/**
 * The relay between a passenger's page and a driver's phone.
 *
 * What may be said is decided in `lib/tracking-chat.ts` and tested there
 * without a database. What only real rows can show is the part that governs
 * who ends up talking to whom: that a message is recorded even when it cannot
 * be delivered, that the thread dies with the journey, and — the one worth the
 * whole file — that a driver taken off a job cannot keep talking to a
 * passenger who is now somebody else's.
 *
 * Telegram is never reached. No bot token is configured in a test database, so
 * `notifyDriver` refuses and `deliveredAt` stays null, which is exactly the
 * undelivered path this needs to assert on anyway.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

describe.skipIf(!DATABASE_AVAILABLE)('the passenger–driver relay', () => {
  const jobIds: string[] = [];
  let driverId = '';
  let otherDriverId = '';
  let made = 0;

  beforeAll(async () => {
    if (!raw) return;
    const [driver, other] = await Promise.all([
      raw.driver.create({
        data: {
          reference: `CHD-${stamp}`,
          name: `Marek Chat ${stamp}`,
          phone: `07700${stamp}1`,
          status: 'ACTIVE',
          // Linked, so the thread's rules see a reachable driver. The send
          // itself still fails for want of a bot token, which is the point.
          telegramChatId: BigInt(`9${stamp}1`),
        },
      }),
      raw.driver.create({
        data: {
          reference: `CHO-${stamp}`,
          name: `Ada Cover ${stamp}`,
          phone: `07700${stamp}2`,
          status: 'ACTIVE',
          telegramChatId: BigInt(`9${stamp}2`),
        },
      }),
    ]);
    driverId = driver.id;
    otherDriverId = other.id;
  });

  afterEach(async () => {
    if (!raw) return;
    await raw.jobChatMessage.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    jobIds.length = 0;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driver.deleteMany({
      where: { id: { in: [driverId, otherDriverId] } },
    });
    await raw.$disconnect();
  });

  async function makeJob(over: Record<string, unknown> = {}): Promise<string> {
    made += 1;
    const job = await raw!.job.create({
      data: {
        reference: `CH-${stamp}-${made}`,
        jobType: 'AIRPORT_TRANSFER',
        status: 'ASSIGNED',
        // An hour out: inside the two-hour window, before the pickup.
        scheduledAt: new Date(Date.now() + 3_600_000),
        pickupText: 'Heathrow Terminal 5',
        dropoffText: 'The Dorchester',
        clientPricePence: 14_500,
        driverPricePence: 9_000,
        driverId,
        ...over,
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  it('records the passenger’s message even when it cannot be delivered', async () => {
    /*
     * The ordering that matters. A message delivered but missing from the page
     * is a passenger repeating themselves at somebody who has already
     * answered; one recorded but undelivered is visible as exactly that and
     * says so. Of the two ways to be wrong, only the second can be acted on.
     */
    const jobId = await makeJob();

    const result = await postFromPassenger(jobId, 'I am by the blue doors');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.body).toBe('I am by the blue doors');
      // No bot token in a test database, so the relay could not go.
      expect(result.message.deliveredAt).toBeNull();
    }

    const thread = await threadFor(jobId);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.author).toBe('PASSENGER');
  });

  it('puts the driver’s reply on the thread, delivered', async () => {
    // The page is the destination, so there is no second hop to fail.
    const jobId = await makeJob();
    await postFromPassenger(jobId, 'Which exit are you at?');

    const reply = await postFromDriver(jobId, driverId, 'Outside arrivals, door 4');

    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.message.deliveredAt).not.toBeNull();

    const thread = await threadFor(jobId);
    expect(thread.map((m) => m.author)).toEqual(['PASSENGER', 'DRIVER']);
  });

  it('refuses a driver who is no longer on the job', async () => {
    /*
     * The rule this file exists for. A reply box opened before a reassignment
     * would otherwise let the previous driver keep talking to a passenger who
     * is now somebody else's — and the passenger would have no way of telling
     * that the person answering is not the person coming.
     */
    const jobId = await makeJob();
    await raw!.job.update({
      where: { id: jobId },
      data: { driverId: otherDriverId },
    });

    const reply = await postFromDriver(jobId, driverId, 'On my way');

    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/no longer on that job/i);
    expect(await threadFor(jobId)).toHaveLength(0);
  });

  it('closes the thread the moment the journey is finished', async () => {
    // Both ways round: neither side can add to a journey that is over.
    const jobId = await makeJob({ status: 'COMPLETED' });

    const fromPassenger = await postFromPassenger(jobId, 'Thanks!');
    const fromDriver = await postFromDriver(jobId, driverId, 'Any time');

    expect(fromPassenger).toMatchObject({ ok: false, reason: 'JOURNEY_OVER' });
    expect(fromDriver).toMatchObject({ ok: false, reason: 'JOURNEY_OVER' });
    expect(await threadFor(jobId)).toHaveLength(0);
  });

  it('refuses before the two-hour window opens', async () => {
    const jobId = await makeJob({
      scheduledAt: new Date(Date.now() + 20 * 3_600_000),
    });

    expect(await postFromPassenger(jobId, 'Hello')).toMatchObject({
      ok: false,
      reason: 'TOO_EARLY',
    });
  });

  it('refuses when the driver has never linked Telegram', async () => {
    // A message box that reaches nobody is worse than none: a passenger who
    // types into it believes they have told somebody, and stops trying.
    const unlinked = await raw!.driver.create({
      data: {
        reference: `CHU-${stamp}`,
        name: `Unlinked ${stamp}`,
        phone: `07700${stamp}3`,
        status: 'ACTIVE',
      },
    });
    const jobId = await makeJob({ driverId: unlinked.id });

    const result = await postFromPassenger(jobId, 'Hello');

    expect(result).toMatchObject({ ok: false, reason: 'DRIVER_UNREACHABLE' });

    await raw!.job.updateMany({ where: { id: jobId }, data: { driverId } });
    await raw!.driver.deleteMany({ where: { id: unlinked.id } });
  });

  it('keeps nothing a passenger did not actually type', async () => {
    const jobId = await makeJob();

    expect(await postFromPassenger(jobId, '   ')).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    expect(await threadFor(jobId)).toHaveLength(0);
  });
});
