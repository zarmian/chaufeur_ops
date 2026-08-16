import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toLondon } from './dates';
import {
  cancelRental,
  createRental,
  deleteRental,
  getRental,
  rentalSchema,
  updateRental,
} from './rental-store';

/**
 * Changing and removing a hire.
 *
 * The guards are the point. A hire is a physical car in a period, so an edit
 * that moves it can double-book; a hire that has been invoiced is a figure on
 * a document the client is holding; and a hire that has taken money cannot be
 * made to have never happened, because the payment is on a bank statement
 * either way.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-7);

let vehicleId = '';
let otherVehicleId = '';
let driverId = '';

/** A summer window, so a mishandled timezone shows up as an hour's drift. */
const START = '2026-07-28T14:30';
const END = '2026-08-02T11:00';

const form = (overrides: Record<string, unknown> = {}) =>
  rentalSchema.parse({
    vehicleId,
    renterType: 'DRIVER',
    driverId,
    startAt: START,
    endAt: END,
    rateType: 'DAILY',
    ratePence: '180.00',
    depositPence: '1000.00',
    ...overrides,
  });

describe.skipIf(!DATABASE_AVAILABLE)('editing and removing a hire', () => {
  beforeAll(async () => {
    if (!raw) return;
    const [vehicle, other, driver] = await Promise.all([
      raw.vehicle.create({
        data: {
          registration: `RE${stamp}`,
          normalisedRegistration: `RE${stamp}`,
          make: 'Land Rover',
          model: 'Range Rover',
        },
      }),
      raw.vehicle.create({
        data: {
          registration: `RF${stamp}`,
          normalisedRegistration: `RF${stamp}`,
          make: 'Mercedes',
          model: 'V Class',
        },
      }),
      raw.driver.create({
        data: {
          name: `Hire Driver ${stamp}`,
          phone: `07700 8${stamp}`,
          normalisedPhone: `77008${stamp}`,
          reference: `DRV-E${stamp}`,
        },
      }),
    ]);
    vehicleId = vehicle.id;
    otherVehicleId = other.id;
    driverId = driver.id;
  });

  beforeEach(async () => {
    if (!raw) return;
    const rentals = await raw.vehicleRental.findMany({
      where: { vehicleId: { in: [vehicleId, otherVehicleId] } },
      select: { id: true },
    });
    const ids = rentals.map((rental) => rental.id);
    await raw.invoiceLine.deleteMany({ where: { rentalId: { in: ids } } });
    await raw.invoice.deleteMany({
      where: { number: { contains: `RENTEDIT${stamp}` } },
    });
    await raw.rentalChecklistItem.deleteMany({ where: { rentalId: { in: ids } } });
    await raw.rentalPayment.deleteMany({ where: { rentalId: { in: ids } } });
    await raw.vehicleRental.deleteMany({
      where: { vehicleId: { in: [vehicleId, otherVehicleId] } },
    });
  });

  afterAll(async () => {
    if (!raw) return;
    const rentals = await raw.vehicleRental.findMany({
      where: { vehicleId: { in: [vehicleId, otherVehicleId] } },
      select: { id: true },
    });
    const ids = rentals.map((rental) => rental.id);
    await raw.invoiceLine.deleteMany({ where: { rentalId: { in: ids } } });
    await raw.invoice.deleteMany({
      where: { number: { contains: `RENTEDIT${stamp}` } },
    });
    await raw.rentalChecklistItem.deleteMany({ where: { rentalId: { in: ids } } });
    await raw.rentalPayment.deleteMany({ where: { rentalId: { in: ids } } });
    await raw.vehicleRental.deleteMany({
      where: { vehicleId: { in: [vehicleId, otherVehicleId] } },
    });
    await raw.vehicle.deleteMany({ where: { id: { in: [vehicleId, otherVehicleId] } } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.$disconnect();
  });

  async function book(overrides: Record<string, unknown> = {}) {
    const result = await createRental(form(overrides), audit);
    if (!result.ok) throw new Error(result.message);
    return result.id;
  }

  it('stores the time that was typed, and hands it back unchanged', async () => {
    // The BST trap. A hire booked at 14:30 on a July evening was stored as
    // 14:30 UTC and displayed in London as 15:30 — an hour late, twice a
    // year. It has to survive the round trip through the edit form too, or
    // opening a hire and saving it would walk it forward an hour each time.
    const id = await book();

    const rental = await getRental(id);
    expect(toLondon(rental!.startAt)).toBe(START);
    expect(toLondon(rental!.endAt)).toBe(END);

    await updateRental(id, form(), audit);
    const again = await getRental(id);
    expect(toLondon(again!.startAt)).toBe(START);
  });

  it('changes the rate and the renter', async () => {
    const id = await book();
    const result = await updateRental(
      id,
      form({
        ratePence: '210.00',
        renterType: 'EXTERNAL',
        hirerName: `Mr James Campbell ${stamp}`,
        hirerLicenceNumber: 'CAMPB902214JA9LJ',
      }),
      audit,
    );
    expect(result.ok).toBe(true);

    const rental = await getRental(id);
    expect(rental?.ratePence).toBe(21_000);
    expect(rental?.renterType).toBe('EXTERNAL');
    // The driver is cleared, not left pointing at somebody unrelated.
    expect(rental?.driverId).toBeNull();
    expect(rental?.hirerLicenceNumber).toBe('CAMPB902214JA9LJ');
  });

  it('does not report the hire clashing with itself', async () => {
    // It always would, perfectly. The overlap check has to exclude the hire
    // being edited or no edit could ever save.
    const id = await book();
    const result = await updateRental(id, form({ ratePence: '200.00' }), audit);
    expect(result.ok).toBe(true);
  });

  it('refuses an edit that would double-book the car', async () => {
    const first = await book();
    const second = await createRental(
      form({
        vehicleId: otherVehicleId,
        startAt: '2026-07-29T09:00',
        endAt: '2026-07-31T09:00',
      }),
      audit,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Moving the second hire onto the first car puts two hires on one car.
    const result = await updateRental(
      second.id,
      form({ startAt: '2026-07-29T09:00', endAt: '2026-07-31T09:00' }),
      audit,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/already on rental/i);
    expect(first).toBeTruthy();
  });

  it('refuses to change or delete a hire that has been invoiced', async () => {
    const id = await book();
    const invoice = await raw!.invoice.create({
      data: {
        number: `RENTEDIT${stamp}-1`,
        issueDate: new Date('2026-08-05'),
        dueDate: new Date('2026-08-19'),
        netPence: 90_000,
        vatPence: 18_000,
        grossPence: 108_000,
        status: 'SENT',
        lines: {
          create: [{ description: 'Vehicle hire', amountPence: 90_000, rentalId: id }],
        },
      },
    });

    const edited = await updateRental(id, form({ ratePence: '999.00' }), audit);
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.message).toContain(invoice.number);

    const removed = await deleteRental(id, audit);
    expect(removed.ok).toBe(false);

    // …and the rate is untouched.
    expect((await getRental(id))?.ratePence).toBe(18_000);
  });

  it('archives a deleted hire rather than destroying it', async () => {
    const id = await book();
    expect((await deleteRental(id, audit)).ok).toBe(true);

    // Gone from every read…
    expect(await getRental(id)).toBeNull();

    // …but the row, and the car's history, are still there.
    const row = await raw!.vehicleRental.findUnique({
      where: { id },
      select: { deletedAt: true, reference: true },
    });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('frees the car once a hire is deleted', async () => {
    // A deleted hire that went on blocking its car would be the worst of both
    // — invisible, and still in the way.
    const id = await book();
    await deleteRental(id, audit);

    const again = await createRental(form(), audit);
    expect(again.ok).toBe(true);
  });

  it('refuses to delete a hire that has taken money, and says what to do', async () => {
    const id = await book();
    await raw!.rentalPayment.create({
      data: { rentalId: id, amountPence: 40_000, paidAt: new Date('2026-07-28') },
    });

    const result = await deleteRental(id, audit);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/cancel it instead/i);

    // Still there, and still owing.
    expect(await getRental(id)).not.toBeNull();
  });

  it('cancels a hire, keeping the record and freeing the car', async () => {
    const id = await book();
    expect((await cancelRental(id, audit)).ok).toBe(true);

    const rental = await getRental(id);
    expect(rental?.status).toBe('CANCELLED');

    // The car is free for the same window.
    const again = await createRental(form(), audit);
    expect(again.ok).toBe(true);
  });

  it('will not cancel a car that has already come back', async () => {
    // The mileage on the car says the hire happened. Cancelling it would
    // claim it never did.
    const id = await book();
    await raw!.vehicleRental.update({
      where: { id },
      data: { status: 'RETURNED', returnedAt: new Date('2026-08-02T10:00:00Z') },
    });

    const result = await cancelRental(id, audit);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/already been booked back in/i);
  });

  it('records who changed it', async () => {
    const id = await book();
    const rental = await getRental(id);
    await updateRental(id, form({ ratePence: '195.00' }), audit);

    const entry = await raw!.auditLog.findFirst({
      where: { entity: 'Vehicle', entityId: rental!.vehicleId, action: 'update' },
      orderBy: { createdAt: 'desc' },
    });
    // Before and after, so "why is this £195" has an answer in six months.
    expect(JSON.stringify(entry?.before)).toContain('18000');
    expect(JSON.stringify(entry?.after)).toContain('19500');
  });
});
