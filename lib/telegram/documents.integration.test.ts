import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordDocument } from '../documents';

/**
 * A document filed from a chat, and where the date ends up.
 *
 * The photo and the buttons need Telegram, so the flow's edges are tested
 * without a database in `documents.test.ts`. What only this can prove is the
 * part that makes the feature worth anything: filing a renewal has to move
 * the **expiry column on the driver or the vehicle**, because that column is
 * what compliance reads on every list render and what blocks a driver from
 * being assigned. A photo stored with the date left where it was is a driver
 * who has complied and is still blocked, still being chased.
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

describe.skipIf(!DATABASE_AVAILABLE)('filing a document from a chat', () => {
  const driverIds: string[] = [];
  const vehicleIds: string[] = [];
  const documentIds: string[] = [];

  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.document.deleteMany({ where: { id: { in: documentIds } } });
    await raw.driver.deleteMany({ where: { id: { in: driverIds } } });
    await raw.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    await raw.$disconnect();
  });

  async function makeDriver(suffix: string, vehicleId?: string): Promise<string> {
    const driver = await raw!.driver.create({
      data: {
        reference: `DOC-${stamp}-${suffix}`,
        name: `Document Driver ${stamp}${suffix}`,
        phone: `07700${stamp}`,
        status: 'ACTIVE',
        // A badge that lapsed last month — the state the chasing is nagging
        // about, and the one a renewal has to clear.
        phvBadgeExpiry: new Date('2025-01-31T00:00:00Z'),
        assignedVehicleId: vehicleId ?? null,
      },
    });
    driverIds.push(driver.id);
    return driver.id;
  }

  async function makeVehicle(suffix: string): Promise<string> {
    const vehicle = await raw!.vehicle.create({
      data: {
        registration: `DC${stamp}${suffix}`,
        normalisedRegistration: `DC${stamp}${suffix}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        motExpiry: new Date('2025-02-28T00:00:00Z'),
      },
    });
    vehicleIds.push(vehicle.id);
    return vehicle.id;
  }

  it('moves the driver’s badge expiry, which is what unblocks them', async () => {
    const driverId = await makeDriver('A');

    const { id } = await recordDocument(
      { driverId },
      { type: 'PHV_BADGE', issuedOn: '', expiresOn: '2027-09-04', mode: 'replace' },
      {
        key: `documents/driver/${driverId}/uuid-phv.jpg`,
        fileName: 'phv_badge.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 84_000,
      },
      {},
    );
    documentIds.push(id);

    const driver = await raw!.driver.findUnique({
      where: { id: driverId },
      select: { phvBadgeExpiry: true },
    });

    // The whole point. Without this the driver has filed a renewal, the
    // office can see the photo, and the system still refuses to assign them.
    expect(driver?.phvBadgeExpiry?.toISOString().slice(0, 10)).toBe('2027-09-04');
  });

  it('moves the vehicle’s MOT when the driver files it', async () => {
    const vehicleId = await makeVehicle('B');
    await makeDriver('B', vehicleId);

    const { id } = await recordDocument(
      { vehicleId },
      { type: 'MOT', issuedOn: '', expiresOn: '2027-03-01', mode: 'replace' },
      {
        key: `documents/driver/whoever/uuid-mot.jpg`,
        fileName: 'mot.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 51_000,
      },
      {},
    );
    documentIds.push(id);

    const vehicle = await raw!.vehicle.findUnique({
      where: { id: vehicleId },
      select: { motExpiry: true },
    });
    expect(vehicle?.motExpiry?.toISOString().slice(0, 10)).toBe('2027-03-01');
  });

  it('supersedes the certificate it renews rather than piling up', async () => {
    /*
     * The old one is kept, not deleted: it is the reason a job last month was
     * compliant, and that has to stay auditable. But only one document of a
     * type is current, or the compliance screen has to guess which.
     */
    const driverId = await makeDriver('C');

    const first = await recordDocument(
      { driverId },
      { type: 'DVLA_LICENCE', issuedOn: '', expiresOn: '2026-06-01', mode: 'replace' },
      {
        key: `documents/driver/${driverId}/uuid-one.jpg`,
        fileName: 'licence.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      },
      {},
    );
    const second = await recordDocument(
      { driverId },
      { type: 'DVLA_LICENCE', issuedOn: '', expiresOn: '2031-06-01', mode: 'replace' },
      {
        key: `documents/driver/${driverId}/uuid-two.jpg`,
        fileName: 'licence.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      },
      {},
    );
    documentIds.push(first.id, second.id);

    const rows = await raw!.document.findMany({
      where: { driverId, type: 'DVLA_LICENCE' },
      select: { id: true, supersededBy: true },
    });

    const superseded = rows.filter((row) => row.supersededBy !== null);
    const current = rows.filter((row) => row.supersededBy === null);

    expect(superseded.map((row) => row.id)).toContain(first.id);
    expect(current.map((row) => row.id)).toEqual([second.id]);

    const driver = await raw!.driver.findUnique({
      where: { id: driverId },
      select: { dvlaLicenceExpiry: true },
    });
    expect(driver?.dvlaLicenceExpiry?.toISOString().slice(0, 10)).toBe('2031-06-01');
  });

  it('records who has no acting user, because drivers are not users', async () => {
    // A driver filing their own paperwork has no user account to attribute
    // it to — `uploadedById` stays null rather than borrowing somebody's.
    const driverId = await makeDriver('D');

    const { id } = await recordDocument(
      { driverId },
      { type: 'DBS', issuedOn: '', expiresOn: '', mode: 'replace' },
      {
        key: `documents/driver/${driverId}/uuid-dbs.jpg`,
        fileName: 'dbs.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      },
      {},
    );
    documentIds.push(id);

    const document = await raw!.document.findUnique({
      where: { id },
      select: { uploadedById: true, expiresOn: true },
    });
    expect(document?.uploadedById).toBeNull();
    // DBS carries no expiry requirement, so none is invented.
    expect(document?.expiresOn).toBeNull();
  });
});
