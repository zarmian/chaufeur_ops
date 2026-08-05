import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkVehicleAvailability, createJob, jobSchema, transitionJob } from './jobs';
import {
  createRental,
  getRental,
  recordRentalPayment,
  rentalSchema,
  returnRental,
  returnSchema,
  totalRentalArrears,
} from './rental-store';

/**
 * Rentals against a real database.
 *
 * The charging rules are unit-tested in `rentals.test.ts`. What only this can
 * prove is that they are wired up: that the reference allocator's raw SQL
 * runs, that a booked car is actually refused for a job, and that the
 * handover checklist is written at both ends.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const audit = { userId: null, ip: null };

function isoIn(days: number, hour = 9): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString().slice(0, 16);
}

describe.skipIf(!DATABASE_AVAILABLE)('rentals', () => {
  const rentalIds: string[] = [];
  const jobIds: string[] = [];
  let vehicleId = '';
  let driverId = '';

  beforeAll(async () => {
    if (!raw) return;
    await raw.$connect();

    const stamp = String(Date.now()).slice(-6);
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `RT${stamp}`,
        normalisedRegistration: `RT${stamp}`,
        make: 'Mercedes-Benz',
        model: 'V-Class',
        vehicleClass: 'MPV',
        seats: 7,
        status: 'ACTIVE',
        motExpiry: far,
        insuranceExpiry: far,
        phvLicenceExpiry: far,
      },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-R${stamp}`,
        name: 'Renting Driver',
        phone: `07700${stamp}`,
        dvlaLicenceExpiry: far,
        phvBadgeExpiry: far,
        assignedVehicleId: vehicle.id,
      },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    if (rentalIds.length > 0) {
      await raw.rentalChecklistItem.deleteMany({ where: { rentalId: { in: rentalIds } } });
      await raw.rentalPayment.deleteMany({ where: { rentalId: { in: rentalIds } } });
      await raw.vehicleRental.deleteMany({ where: { id: { in: rentalIds } } });
    }
    if (jobIds.length > 0) {
      await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    if (driverId) await raw.driver.deleteMany({ where: { id: driverId } });
    if (vehicleId) await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  async function book(overrides: Record<string, unknown> = {}) {
    const parsed = rentalSchema.parse({
      vehicleId,
      driverId,
      startAt: isoIn(30),
      endAt: isoIn(37),
      rateType: 'DAILY',
      ratePence: '80.00',
      depositPence: '300.00',
      mileageOut: '41200',
      fuelOutPct: '100',
      ...overrides,
    });
    const result = await createRental(parsed, audit);
    if (result.ok) rentalIds.push(result.id);
    return result;
  }

  it('allocates a reference and writes the collection checklist', async () => {
    const result = await book();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.reference).toMatch(/^RNT-\d{6,}$/);

    const checks = await raw!.rentalChecklistItem.findMany({
      where: { rentalId: result.id },
    });
    expect(checks.length).toBeGreaterThan(5);
    expect(checks.every((check) => check.phase === 'OUT')).toBe(true);
  });

  it('refuses to double-book the same car', async () => {
    // There is only one car. This is a refusal, not a warning.
    const clash = await book({ startAt: isoIn(33), endAt: isoIn(40) });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.message).toMatch(/RNT-/);
  });

  it('allows a booking after the first one ends', async () => {
    const later = await book({ startAt: isoIn(45), endAt: isoIn(50) });
    expect(later.ok).toBe(true);
  });

  it('refuses a car out on rent for a job in that period', async () => {
    // Spec 2.5.3.10 — refused the same way a lapsed MOT is.
    const at = new Date();
    at.setDate(at.getDate() + 33);
    const availability = await checkVehicleAvailability(vehicleId, at);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.message).toMatch(/rental RNT-/);
  });

  it('blocks assigning that car to a job, naming the rental', async () => {
    const day = new Date();
    day.setDate(day.getDate() + 33);

    const job = await createJob(
      jobSchema.parse({
        jobType: 'TRANSFER',
        scheduledDate: day.toISOString().slice(0, 10),
        scheduledTime: '14:30',
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow T5',
        driverId,
        vehicleId,
        clientPricePence: '125.50',
      }),
      audit,
    );
    jobIds.push(job.id);

    const result = await transitionJob(job.id, 'ASSIGNED', audit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons?.join(' ')).toMatch(/rental RNT-/);
    }
  });

  it('leaves the car free for a job outside every rental', async () => {
    const at = new Date();
    at.setDate(at.getDate() + 100);
    expect(await checkVehicleAvailability(vehicleId, at)).toEqual({ ok: true });
  });

  it('charges the hire and tracks what is still owed', async () => {
    const booking = await book({ startAt: isoIn(200), endAt: isoIn(207) });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;

    const before = await getRental(booking.id);
    // Seven days at £80.
    expect(before?.balance.rentalPence).toBe(56000);
    expect(before?.balance.balancePence).toBe(56000);
    expect(before?.balance.inArrears).toBe(true);
    // The deposit secures the car; it is not a payment toward the hire.
    expect(before?.balance.depositHeldPence).toBe(30000);

    await recordRentalPayment(booking.id, 30000, new Date(), audit);
    const after = await getRental(booking.id);
    expect(after?.balance.paidPence).toBe(30000);
    expect(after?.balance.balancePence).toBe(26000);
  });

  it('refuses a payment of zero or less', async () => {
    const booking = await book({ startAt: isoIn(300), endAt: isoIn(302) });
    if (!booking.ok) return;
    expect((await recordRentalPayment(booking.id, 0, new Date(), audit)).ok).toBe(false);
  });

  it('books a car back in with damage, and the balance reflects it', async () => {
    const booking = await book({ startAt: isoIn(400), endAt: isoIn(404) });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;

    const result = await returnRental(
      booking.id,
      returnSchema.parse({
        returnedAt: isoIn(404, 17),
        mileageIn: '42350',
        fuelInPct: '25',
        damageNotes: 'Scratch to the nearside rear door',
        damageChargePence: '150.00',
      }),
      audit,
    );
    expect(result.ok).toBe(true);

    const rental = await getRental(booking.id);
    expect(rental?.status).toBe('RETURNED');
    // Out at 09:00, back at 17:00 four days later: four days and eight hours,
    // which is a fifth day. That round-up is the rule — an extra hour on a
    // daily hire is another day.
    expect(rental?.balance.periods).toBe(5);
    expect(rental?.balance.rentalPence).toBe(40000);
    // Damage is charged on top of the rate, not folded into it.
    expect(rental?.balance.damageChargePence).toBe(15000);
    expect(rental?.balance.totalPence).toBe(55000);

    // And the return checklist now exists alongside the collection one.
    const phases = new Set(rental?.checks.map((check) => check.phase));
    expect(phases).toEqual(new Set(['OUT', 'IN']));
  });

  it('refuses to book the same car back in twice', async () => {
    const booking = await book({ startAt: isoIn(500), endAt: isoIn(502) });
    if (!booking.ok) return;

    const first = await returnRental(
      booking.id,
      returnSchema.parse({ returnedAt: isoIn(502, 17), damageChargePence: '0' }),
      audit,
    );
    expect(first.ok).toBe(true);

    const second = await returnRental(
      booking.id,
      returnSchema.parse({ returnedAt: isoIn(502, 18), damageChargePence: '0' }),
      audit,
    );
    expect(second.ok).toBe(false);
  });

  it('frees the car once it is back, even before the planned end', async () => {
    const booking = await book({ startAt: isoIn(600), endAt: isoIn(620) });
    if (!booking.ok) return;

    await returnRental(
      booking.id,
      returnSchema.parse({ returnedAt: isoIn(605), damageChargePence: '0' }),
      audit,
    );

    const at = new Date();
    at.setDate(at.getDate() + 610);
    expect(await checkVehicleAvailability(vehicleId, at)).toEqual({ ok: true });
  });

  it('reports arrears across every open rental', async () => {
    const arrears = await totalRentalArrears();
    expect(arrears.count).toBeGreaterThan(0);
    expect(arrears.pence).toBeGreaterThan(0);
  });

  it('refuses a rental that ends before it starts', async () => {
    expect(() =>
      rentalSchema.parse({
        vehicleId,
        driverId,
        startAt: isoIn(37),
        endAt: isoIn(30),
        rateType: 'DAILY',
        ratePence: '80.00',
      }),
    ).toThrow();
  });

  it('refuses a rental with no rate', async () => {
    // A rental with no rate earns nothing, which is never the intent.
    expect(() =>
      rentalSchema.parse({
        vehicleId,
        driverId,
        startAt: isoIn(30),
        endAt: isoIn(37),
        rateType: 'DAILY',
        ratePence: '0',
      }),
    ).toThrow();
  });
});
