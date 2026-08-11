import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleUpdate } from './handle';
import { redeemLinkToken, createLinkToken } from './linking';

/**
 * Live location, which arrives as an edit rather than a message.
 *
 * Telegram's "share live location" sends one message and then edits it, over
 * and over, for as long as the driver chose. Only the first arrives as
 * `message`; every movement after it is an `edited_message`.
 *
 * The router handled `message` and `callback_query` and dropped edits on the
 * floor, so a driver could share live location for an hour and the database
 * would hold one position: where they were when they set off. The ETA built
 * on top of it went stale ten minutes later and stayed stale. This pins the
 * routing, because it is invisible until somebody is actually driving.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  : null;

const stamp = String(Date.now()).slice(-7);
const CHAT_ID = BigInt(`99${stamp}`);
const SETTING_KEY = 'telegram';

describe.skipIf(!DATABASE_AVAILABLE)('live location', () => {
  let driverId = '';
  let jobId = '';
  let previousConfig: unknown = null;

  beforeAll(async () => {
    if (!raw) return;

    // Position capture is off unless an operator turned it on.
    const existing = await raw.setting.findUnique({ where: { key: SETTING_KEY } });
    previousConfig = existing?.value ?? null;
    const value = {
      ...((existing?.value as Record<string, unknown>) ?? {}),
      requestLocation: true,
    };
    await raw.setting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value },
      update: { value },
    });

    const driver = await raw.driver.create({
      data: {
        name: `Live Driver ${stamp}`,
        phone: `07700 8${stamp}`,
        normalisedPhone: `4477008${stamp}`,
        reference: `LIVE-${stamp}`,
      },
    });
    driverId = driver.id;

    const issued = await createLinkToken(driverId);
    if (issued.ok) await redeemLinkToken(issued.token, CHAT_ID);

    const job = await raw.job.create({
      data: {
        reference: `LIVEJOB-${stamp}`,
        jobType: 'TRANSFER',
        status: 'IN_PROGRESS',
        scheduledAt: new Date(),
        pickupText: 'The Savoy, Strand',
        dropoffText: 'Heathrow T5',
        pickupLat: 51.5101,
        pickupLng: -0.1206,
        driverId,
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driverPosition.deleteMany({ where: { driverId } });
    await raw.job.deleteMany({ where: { id: jobId } });
    await raw.linkToken.deleteMany({ where: { driverId } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    if (previousConfig === null) {
      await raw.setting.deleteMany({ where: { key: SETTING_KEY } });
    } else {
      await raw.setting.update({
        where: { key: SETTING_KEY },
        data: { value: previousConfig as never },
      });
    }
    await raw.$disconnect();
  });

  it('records the first share, which arrives as a message', async () => {
    await handleUpdate({
      message: {
        chat: { id: Number(CHAT_ID) },
        location: { latitude: 51.5085, longitude: -0.085 },
      },
    });

    const positions = await raw!.driverPosition.findMany({ where: { driverId } });
    expect(positions).toHaveLength(1);
  });

  it('records the movement, which arrives as an edit', async () => {
    // The regression this file exists for.
    await handleUpdate({
      edited_message: {
        chat: { id: Number(CHAT_ID) },
        location: { latitude: 51.5095, longitude: -0.1 },
      },
    });

    const positions = await raw!.driverPosition.findMany({
      where: { driverId },
      orderBy: { recordedAt: 'desc' },
    });
    expect(positions.length).toBeGreaterThanOrEqual(2);
    expect(positions[0]!.lng).toBeCloseTo(-0.1);
    expect(positions[0]!.jobId).toBe(jobId);
  });

  it('ignores an edit that is not a location', async () => {
    // Editing a typo in an expense is not a second expense, and re-running a
    // command because its message was edited is how one tap becomes two.
    const before = await raw!.driverPosition.count({ where: { driverId } });

    const result = await handleUpdate({
      edited_message: { chat: { id: Number(CHAT_ID) }, text: '/today' },
    });

    expect(result.kind).toBe('unknown');
    expect(await raw!.driverPosition.count({ where: { driverId } })).toBe(before);
  });
});
