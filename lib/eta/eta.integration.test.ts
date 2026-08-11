import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { etaForJob } from './store';

/**
 * What the client is told, against a real database.
 *
 * The rule these pin is that silence beats a confident wrong number. A client
 * acts on "about 10 minutes" — they stop what they are doing and go to the
 * door. Producing that from a position recorded half an hour ago, or from a
 * pickup nobody ever resolved to a coordinate, is worse than saying nothing,
 * because nothing is what the message did before this feature existed.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  : null;

const stamp = String(Date.now()).slice(-7);
const NOW = new Date('2026-08-10T12:00:00.000Z');

// The Savoy, and a driver about 3km away on the Embankment.
const PICKUP = { lat: 51.5101, lng: -0.1206 };
const NEARBY = { lat: 51.5085, lng: -0.0850 };

describe.skipIf(!DATABASE_AVAILABLE)('etaForJob', () => {
  let driverId = '';
  let jobId = '';
  let unlocatedJobId = '';

  beforeAll(async () => {
    if (!raw) return;

    const driver = await raw.driver.create({
      data: {
        name: `ETA Driver ${stamp}`,
        phone: `07700 9${stamp}`,
        normalisedPhone: `4477009${stamp}`,
        reference: `ETA-${stamp}`,
      },
    });
    driverId = driver.id;

    const job = await raw.job.create({
      data: {
        reference: `ETAJOB-${stamp}`,
        jobType: 'TRANSFER',
        status: 'IN_PROGRESS',
        scheduledAt: NOW,
        pickupText: 'The Savoy, Strand',
        dropoffText: 'Heathrow T5',
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        driverId,
      },
    });
    jobId = job.id;

    // The same journey, with a pickup somebody typed by hand.
    const unlocated = await raw.job.create({
      data: {
        reference: `ETANOGEO-${stamp}`,
        jobType: 'TRANSFER',
        status: 'IN_PROGRESS',
        scheduledAt: NOW,
        pickupText: 'Round the back of the pub',
        dropoffText: 'Heathrow T5',
        driverId,
      },
    });
    unlocatedJobId = unlocated.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driverPosition.deleteMany({ where: { driverId } });
    await raw.job.deleteMany({ where: { id: { in: [jobId, unlocatedJobId] } } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.$disconnect();
  });

  it('says nothing when the driver has never shared a position', async () => {
    expect(await etaForJob(jobId, NOW)).toBeNull();
  });

  it('estimates from the most recent position', async () => {
    if (!raw) return;

    // An older, further ping and a newer, nearer one. The newer must win, or
    // the client is told where the driver used to be.
    await raw.driverPosition.create({
      data: {
        driverId,
        jobId,
        lat: 51.47,
        lng: -0.489,
        recordedAt: new Date(NOW.getTime() - 8 * 60_000),
      },
    });
    await raw.driverPosition.create({
      data: {
        driverId,
        jobId,
        lat: NEARBY.lat,
        lng: NEARBY.lng,
        recordedAt: new Date(NOW.getTime() - 60_000),
      },
    });

    const eta = await etaForJob(jobId, NOW);
    expect(eta).not.toBeNull();
    // ~2.5km on the Embankment, not the 25km from Heathrow.
    expect(eta!.estimate.metres).toBeLessThan(6_000);
    expect(eta!.phrase).toMatch(/minutes away|arriving now/);
    expect(eta!.positionAt.getTime()).toBe(NOW.getTime() - 60_000);
  });

  it('falls silent once the position is too old to mean anything', async () => {
    if (!raw) return;

    // The phone lost signal. The last thing it said goes on looking true.
    await raw.driverPosition.deleteMany({ where: { driverId } });
    await raw.driverPosition.create({
      data: {
        driverId,
        jobId,
        lat: NEARBY.lat,
        lng: NEARBY.lng,
        recordedAt: new Date(NOW.getTime() - 45 * 60_000),
      },
    });

    expect(await etaForJob(jobId, NOW)).toBeNull();
  });

  it('says nothing when the pickup was never resolved to a coordinate', async () => {
    if (!raw) return;

    await raw.driverPosition.create({
      data: {
        driverId,
        jobId: unlocatedJobId,
        lat: NEARBY.lat,
        lng: NEARBY.lng,
        recordedAt: new Date(NOW.getTime() - 60_000),
      },
    });

    expect(await etaForJob(unlocatedJobId, NOW)).toBeNull();
  });
});
