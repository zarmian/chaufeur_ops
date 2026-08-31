import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportDelay } from './delays';

/**
 * A driver reporting a delay.
 *
 * The thing worth proving is that the report lands on the **job** rather than
 * only in a chat. A delay told to the office as a line of text answers "is
 * anyone coming?" today and nothing at all three weeks later, when a client is
 * disputing a late arrival and the question is when the operator knew. So the
 * assertions here are about the `DELAYED` event and the number on it.
 *
 * The refusals matter as much as the recording. A button survives a
 * reassignment — the previous driver still has the message — so a tap can
 * arrive from somebody the job no longer belongs to, and recording that would
 * send the office chasing the wrong car.
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
const PICKUP_AT = new Date('2113-05-09T09:00:00Z');

describe.skipIf(!DATABASE_AVAILABLE)('reporting a delay', () => {
  const jobIds: string[] = [];
  const driverIds: string[] = [];

  async function makeDriver(suffix: string): Promise<string> {
    const driver = await raw!.driver.create({
      data: {
        reference: `DL-${stamp}-${suffix}`,
        name: `Delay Driver ${stamp}${suffix}`,
        phone: `07700${stamp}`,
        status: 'ACTIVE',
      },
    });
    driverIds.push(driver.id);
    return driver.id;
  }

  async function makeJob(driverId: string | null, status = 'ASSIGNED'): Promise<string> {
    const job = await raw!.job.create({
      data: {
        reference: `DLY-${stamp}-${jobIds.length}`,
        jobType: 'TRANSFER',
        status: status as never,
        scheduledAt: PICKUP_AT,
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow Terminal 5',
        clientPricePence: 12_000,
        driverId,
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driver.deleteMany({ where: { id: { in: driverIds } } });
    await raw.$disconnect();
  });

  it('writes the delay onto the job, with the number', async () => {
    const driverId = await makeDriver('A');
    const jobId = await makeJob(driverId);

    const outcome = await reportDelay(jobId, driverId, 15);
    expect(outcome.recorded).toBe(true);

    const event = await raw!.jobEvent.findFirst({
      where: { jobId, type: 'DELAYED' },
    });
    expect(event).not.toBeNull();
    expect(event?.actorType).toBe('DRIVER');
    expect(event?.actorId).toBe(driverId);

    // The number the driver chose, so the record answers "how late did they
    // say?" and not merely "they said something".
    const metadata = event?.metadata as { minutes?: number; expectedAt?: string } | null;
    expect(metadata?.minutes).toBe(15);
    expect(new Date(metadata!.expectedAt!).getTime()).toBe(
      PICKUP_AT.getTime() + 15 * 60 * 1000,
    );
  });

  it('refuses a driver the job is no longer on', async () => {
    /*
     * The reassignment case. A driver taken off a job still has the message
     * and its buttons in their chat, and a delay recorded from there would
     * have the office ringing somebody who is not going.
     */
    const wasDriving = await makeDriver('B');
    const nowDriving = await makeDriver('C');
    const jobId = await makeJob(nowDriving);

    const outcome = await reportDelay(jobId, wasDriving, 10);

    expect(outcome.recorded).toBe(false);
    expect(outcome.message).toContain('not yours');
    expect(await raw!.jobEvent.count({ where: { jobId, type: 'DELAYED' } })).toBe(0);
  });

  it('refuses a job that is already closed', async () => {
    const driverId = await makeDriver('D');
    const jobId = await makeJob(driverId, 'COMPLETED');

    const outcome = await reportDelay(jobId, driverId, 20);

    expect(outcome.recorded).toBe(false);
    expect(await raw!.jobEvent.count({ where: { jobId, type: 'DELAYED' } })).toBe(0);
  });

  it('refuses a job that no longer exists', async () => {
    const driverId = await makeDriver('E');
    const outcome = await reportDelay('not-a-real-job', driverId, 5);
    expect(outcome.recorded).toBe(false);
  });

  it('records a second delay rather than replacing the first', async () => {
    // A journey that gets worse. Both numbers are what happened, and the
    // history is the point.
    const driverId = await makeDriver('F');
    const jobId = await makeJob(driverId);

    await reportDelay(jobId, driverId, 10);
    await reportDelay(jobId, driverId, 30);

    const events = await raw!.jobEvent.findMany({
      where: { jobId, type: 'DELAYED' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect((events[0]?.metadata as { minutes?: number }).minutes).toBe(10);
    expect((events[1]?.metadata as { minutes?: number }).minutes).toBe(30);
  });
});
