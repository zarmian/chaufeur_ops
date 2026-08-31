import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createVehicle, updateVehicle, vehicleSchema } from './vehicles';

/**
 * The payment on a financed or leased car.
 *
 * The gap this closes: the ownership form asked for a purchase price, which a
 * lease does not have, and never asked for the payment — which is the whole
 * cost of holding the car. So every leased vehicle reported a profit it was
 * not making, and the largest running cost on the fleet was on nobody's books.
 *
 * The payment is not a column on `Vehicle`. It is a `VehicleStandingCost`,
 * which the per-vehicle P&L already accrues across the months it covers — one
 * record of the payment rather than two that can disagree.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-6);

const form = (overrides: Record<string, unknown> = {}) =>
  vehicleSchema.parse({
    registration: `LF${stamp}`,
    make: 'Land Rover',
    model: 'Range Rover',
    vehicleClass: 'LUXURY',
    status: 'ACTIVE',
    ...overrides,
  });

async function agreementFor(vehicleId: string) {
  return raw!.vehicleStandingCost.findFirst({
    where: { vehicleId, kind: { in: ['FINANCE', 'LEASE'] } },
    orderBy: { startsOn: 'desc' },
  });
}

describe.skipIf(!DATABASE_AVAILABLE)('finance and lease payments', () => {
  let vehicleId = '';

  beforeEach(async () => {
    if (!raw) return;
    await raw.vehicleStandingCost.deleteMany({
      where: { vehicle: { registration: { contains: stamp } } },
    });
    await raw.vehicle.deleteMany({ where: { registration: { contains: stamp } } });
    vehicleId = '';
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.vehicleStandingCost.deleteMany({
      where: { vehicle: { registration: { contains: stamp } } },
    });
    await raw.vehicle.deleteMany({ where: { registration: { contains: stamp } } });
    await raw.$disconnect();
  });

  it('records the lease payment as a standing cost', async () => {
    const created = await createVehicle(
      form({
        ownership: 'LEASED',
        financePayment: '750.00',
        financePeriodMonths: '1',
        financeStartsOn: '2026-01-01',
        financeProvider: 'Arval',
      }),
      audit,
    );
    vehicleId = created.id;

    const agreement = await agreementFor(vehicleId);
    expect(agreement?.kind).toBe('LEASE');
    expect(agreement?.amountPence).toBe(75_000);
    expect(agreement?.periodMonths).toBe(1);
    expect(agreement?.label).toBe('Lease — Arval');
    expect(agreement?.startsOn.toISOString().slice(0, 10)).toBe('2026-01-01');
    // Blank end means it is still running, which is the normal case.
    expect(agreement?.endsOn).toBeNull();
  });

  it('calls a financed car’s payment finance, not lease', async () => {
    const created = await createVehicle(
      form({ ownership: 'FINANCED', financePayment: '620.00' }),
      audit,
    );
    vehicleId = created.id;
    expect((await agreementFor(vehicleId))?.kind).toBe('FINANCE');
  });

  it('updates the payment in place rather than stacking a second one', async () => {
    const created = await createVehicle(
      form({ ownership: 'LEASED', financePayment: '750.00', financeStartsOn: '2026-01-01' }),
      audit,
    );
    vehicleId = created.id;

    await updateVehicle(
      vehicleId,
      form({ ownership: 'LEASED', financePayment: '810.00', financeStartsOn: '2026-01-01' }),
      audit,
    );

    const all = await raw!.vehicleStandingCost.findMany({ where: { vehicleId } });
    // Two open agreements on one car would double the cost in every report.
    expect(all).toHaveLength(1);
    expect(all[0]?.amountPence).toBe(81_000);
  });

  it('leaves the payment alone when the box is not filled in', async () => {
    // A blank means "not stated", not "the payment is nothing". Someone
    // correcting the colour must not wipe the lease off the car.
    const created = await createVehicle(
      form({ ownership: 'LEASED', financePayment: '750.00' }),
      audit,
    );
    vehicleId = created.id;

    await updateVehicle(
      vehicleId,
      form({ ownership: 'LEASED', colour: 'Santorini Black' }),
      audit,
    );

    expect((await agreementFor(vehicleId))?.amountPence).toBe(75_000);
  });

  it('closes the agreement when the car is bought out, and keeps the history', async () => {
    // A car leased January to June and bought in July really did cost six
    // months of lease payments. Deleting the agreement would rewrite that
    // period's profit; ending it stops the accrual from today.
    const created = await createVehicle(
      form({ ownership: 'LEASED', financePayment: '750.00', financeStartsOn: '2026-01-01' }),
      audit,
    );
    vehicleId = created.id;

    await updateVehicle(
      vehicleId,
      form({ ownership: 'OWNED', purchasePrice: '34500.00' }),
      audit,
    );

    const agreement = await agreementFor(vehicleId);
    expect(agreement).not.toBeNull();
    expect(agreement?.amountPence).toBe(75_000);
    expect(agreement?.endsOn).not.toBeNull();
    expect(agreement?.startsOn.toISOString().slice(0, 10)).toBe('2026-01-01');

    const vehicle = await raw!.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(vehicle.purchasePricePence).toBe(3_450_000);
  });

  it('ends the agreement when the car goes back to its driver', async () => {
    const created = await createVehicle(
      form({ ownership: 'FINANCED', financePayment: '620.00' }),
      audit,
    );
    vehicleId = created.id;

    await updateVehicle(vehicleId, form({ ownership: 'DRIVER_OWNED' }), audit);
    expect((await agreementFor(vehicleId))?.endsOn).not.toBeNull();
  });

  it('creates nothing for a car nobody is paying instalments on', async () => {
    const created = await createVehicle(
      form({ ownership: 'OWNED', purchasePrice: '34500.00' }),
      audit,
    );
    vehicleId = created.id;
    expect(await agreementFor(vehicleId)).toBeNull();
  });
});
