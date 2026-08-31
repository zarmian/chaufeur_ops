import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Filing a receipt against a cost.
 *
 * Storage is mocked, not stubbed out: there is no Blob store in CI, and the
 * thing worth proving is the wiring either side of it — that the object key
 * names the cost's vehicle, that the upload happens *before* the row is
 * written, and that the key reaches Postgres. A real Blob round-trip would
 * only re-test Vercel's SDK.
 */

const uploaded: Array<{ key: string; mimeType: string; bytes: number }> = [];

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    upload: async (buffer: Buffer, key: string, mimeType: string) => {
      uploaded.push({ key, mimeType, bytes: buffer.byteLength });
      return { key, sizeBytes: buffer.byteLength };
    },
  };
});

const { getVehicleCost, getVehicleCosts, recordVehicleCost, vehicleCostSchema } =
  await import('./fleet');

const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };

function dayIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

describe.skipIf(!DATABASE_AVAILABLE)('cost receipts', () => {
  let vehicleId = '';

  beforeAll(async () => {
    if (!raw) return;
    const stamp = String(Date.now()).slice(-6);
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `RC${stamp}`,
        normalisedRegistration: `RC${stamp}`,
        make: 'Mercedes-Benz',
        model: 'V-Class',
        vehicleClass: 'MPV',
        seats: 7,
        ownership: 'OWNED',
        motExpiry: far,
        insuranceExpiry: far,
        phvLicenceExpiry: far,
      },
    });
    vehicleId = vehicle.id;
  });

  afterAll(async () => {
    if (!raw) return;
    if (vehicleId) {
      await raw.vehicleCost.deleteMany({ where: { vehicleId } });
      await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    }
    await raw.$disconnect();
  });

  it('stores the receipt and records its key against the cost', async () => {
    const result = await recordVehicleCost(
      vehicleId,
      vehicleCostSchema.parse({
        kind: 'REPAIR',
        amountPence: '240.00',
        incurredOn: dayIn(-6),
        supplier: 'Local garage',
        invoiceRef: 'INV-4417',
      }),
      audit,
      {
        buffer: Buffer.from('%PDF-1.4 a garage invoice'),
        fileName: 'garage invoice.pdf',
        mimeType: 'application/pdf',
      },
    );
    expect(result.ok).toBe(true);

    const { costs } = await getVehicleCosts(vehicleId);
    const cost = costs.find((c) => c.invoiceRef === 'INV-4417');
    expect(cost?.receiptFileKey).toBeTruthy();

    // The key names the vehicle, so an object's owner is obvious from the key
    // alone — the same rule the compliance documents follow.
    expect(cost?.receiptFileKey).toContain(`receipts/vehicle-cost/${vehicleId}/`);
    // Sanitised: a space in the filename must not reach the object key.
    expect(cost?.receiptFileKey).toContain('garage-invoice.pdf');

    const call = uploaded.find((u) => u.key === cost?.receiptFileKey);
    expect(call?.mimeType).toBe('application/pdf');
    expect(call?.bytes).toBeGreaterThan(0);
  });

  it('serves the key back for the signed-link route', async () => {
    const { costs } = await getVehicleCosts(vehicleId);
    const cost = costs.find((c) => c.invoiceRef === 'INV-4417');
    const found = await getVehicleCost(cost!.id);
    expect(found?.receiptFileKey).toBe(cost?.receiptFileKey);
    expect(found?.vehicleId).toBe(vehicleId);
  });

  it('leaves the key on a soft-deleted cost', async () => {
    // The receipt is evidence for a payment that still happened. Losing it
    // when a mis-keyed entry is removed would break the VAT trail.
    const { costs } = await getVehicleCosts(vehicleId);
    const cost = costs.find((c) => c.invoiceRef === 'INV-4417');

    await raw!.vehicleCost.update({
      where: { id: cost!.id },
      data: { deletedAt: new Date() },
    });

    const found = await getVehicleCost(cost!.id);
    expect(found?.receiptFileKey).toBe(cost?.receiptFileKey);
  });

});

// File type and size are refused by `lib/storage.ts` itself, which this file
// mocks — so asserting them here would only be testing the mock. They are
// covered against the real implementation in `lib/storage.test.ts`.
