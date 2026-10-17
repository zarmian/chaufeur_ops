import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rawPrismaClient } from './raw-prisma';
import {
  placeInboundText,
  postFromDriver,
  postFromPassenger,
  threadFor,
} from './tracking-chat-store';

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

describe.skipIf(!DATABASE_AVAILABLE)('placing an inbound text', () => {
  /**
   * The SMS half of the relay, where the thread has to be inferred.
   *
   * The pure decision is `routeInbound`, tested without a database. What only
   * real rows can show is that the candidates handed to it are the right ones:
   * this driver's live journeys, with an open thread, and the passenger's last
   * question on each. Pick those wrongly and the decision is sound but the
   * answer lands on a stranger's page.
   */
  const jobIds: string[] = [];
  let smsDriverId = '';
  let made = 0;

  beforeAll(async () => {
    if (!raw) return;
    const driver = await raw.driver.create({
      data: {
        reference: `SMS-${stamp}`,
        name: `Texter ${stamp}`,
        phone: `07700 9${stamp}`,
        // The column the lookup matches on, normalised the way `lib/text.ts`
        // does it: `+44…` and `07…` are the same number.
        normalisedPhone: `077009${stamp}`,
        status: 'ACTIVE',
      },
    });
    smsDriverId = driver.id;
  });

  afterEach(async () => {
    if (!raw) return;
    await raw.jobChatMessage.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    jobIds.length = 0;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driver.deleteMany({ where: { id: smsDriverId } });
  });

  async function jobForSms(over: Record<string, unknown> = {}): Promise<string> {
    made += 1;
    const job = await raw!.job.create({
      data: {
        reference: `SJ-${stamp}-${made}`,
        jobType: 'AIRPORT_TRANSFER',
        status: 'ASSIGNED',
        scheduledAt: new Date(Date.now() + 3_600_000),
        pickupText: 'Heathrow Terminal 5',
        dropoffText: 'The Dorchester',
        clientPricePence: 14_500,
        driverPricePence: 9_000,
        driverId: smsDriverId,
        ...over,
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  /** A passenger question on the thread, at a given moment. */
  async function asked(jobId: string, at: Date) {
    await raw!.jobChatMessage.create({
      data: {
        jobId,
        author: 'PASSENGER',
        body: 'Which exit are you at?',
        createdAt: at,
      },
    });
  }

  const text = (body: string, from = `+447700 9${stamp}`) => ({
    from,
    body,
    providerId: `msg-${Math.random().toString(36).slice(2)}`,
    receivedAt: new Date(),
  });

  it('puts a reply on the thread the passenger asked in', async () => {
    const jobId = await jobForSms();
    await asked(jobId, new Date(Date.now() - 120_000));

    const placed = await placeInboundText(text('Outside door 4'));

    expect(placed.placed).toBe(true);
    if (placed.placed) expect(placed.jobId).toBe(jobId);

    const thread = await threadFor(jobId);
    expect(thread.map((m) => m.author)).toEqual(['PASSENGER', 'DRIVER']);
    expect(thread[1]?.body).toBe('Outside door 4');
    // The page is the destination, so there is no second hop to fail.
    expect(thread[1]?.deliveredAt).not.toBeNull();
  });

  it('matches the driver however their number was written', async () => {
    // The text arrives in international form; the driver was entered as
    // `07700…`. Folding them is the whole reason `normalisedPhone` exists.
    const jobId = await jobForSms();
    await asked(jobId, new Date(Date.now() - 120_000));

    const placed = await placeInboundText(text('On my way', `0770 09${stamp}`));

    expect(placed.placed).toBe(true);
  });

  it('gives the office a text from a number that is not a driver', async () => {
    const placed = await placeInboundText(text('Who is this?', '+447000000001'));

    expect(placed).toMatchObject({ placed: false, reason: 'UNKNOWN_SENDER' });
  });

  it('gives the office an unprompted text rather than a passenger', async () => {
    /*
     * A journey is live but nobody has asked anything, so this is not a reply
     * to a passenger — it is a driver telling the office something. Showing it
     * on a tracking page would be the system volunteering a driver's words to
     * a client who never spoke to them.
     */
    await jobForSms();

    const placed = await placeInboundText(text('Stuck on the M4'));

    expect(placed).toMatchObject({ placed: false, reason: 'NO_OPEN_THREAD' });
  });

  it('gives the office a text it cannot place between two recent questions', async () => {
    // The branch that stops one client reading another client's answer.
    const first = await jobForSms();
    const second = await jobForSms();
    await asked(first, new Date(Date.now() - 90_000));
    await asked(second, new Date(Date.now() - 60_000));

    const placed = await placeInboundText(text('Two minutes away'));

    expect(placed).toMatchObject({ placed: false, reason: 'AMBIGUOUS' });
    expect(await threadFor(first)).toHaveLength(1);
    expect(await threadFor(second)).toHaveLength(1);
  });

  it('answers the passenger who asked most recently when the gap is clear', async () => {
    const older = await jobForSms();
    const newer = await jobForSms();
    await asked(older, new Date(Date.now() - 40 * 60_000));
    await asked(newer, new Date(Date.now() - 60_000));

    const placed = await placeInboundText(text('Nearly there'));

    expect(placed.placed).toBe(true);
    if (placed.placed) expect(placed.jobId).toBe(newer);
  });

  it('refuses a text once the journey is over', async () => {
    // The thread closes with the link. A reply arriving afterwards belongs to
    // the office, not to a page the passenger can no longer open.
    const jobId = await jobForSms();
    await asked(jobId, new Date(Date.now() - 120_000));
    await raw!.job.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });

    const placed = await placeInboundText(text('Thanks!'));

    expect(placed.placed).toBe(false);
  });
});
