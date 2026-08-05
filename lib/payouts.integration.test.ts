import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftPayout } from './payouts';
import { billableFor, revenueFor } from './revenue';

/**
 * The two seams Phase 4 needs, against a real database.
 *
 * Unit tests cover the arithmetic. What only this can prove is that the
 * schema actually permits what the logic assumes — that a payout line can
 * carry a shift instead of a job, that an invoice line can carry a rental,
 * and that neither can carry two things at once. Those are database
 * constraints, and a mock would prove nothing about them.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const stamp = String(Date.now()).slice(-6);

const PERIOD = {
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-06-30T23:59:59Z'),
};

describe.skipIf(!DATABASE_AVAILABLE)('payout and invoice seams', () => {
  let driverId = '';
  let vehicleId = '';
  let shiftId = '';
  let shiftJobId = '';
  let ownJobId = '';
  let rentalId = '';
  let payoutId = '';
  let invoiceId = '';

  beforeAll(async () => {
    if (!raw) return;
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `PS${stamp}`,
        normalisedRegistration: `PS${stamp}`,
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

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-P${stamp}`,
        name: 'Payout Tester',
        phone: `07700${stamp}`,
        normalisedPhone: `07700${stamp}`,
        dvlaLicenceExpiry: far,
        phvBadgeExpiry: far,
      },
    });
    driverId = driver.id;

    // An eight-hour shift at £17/hour, with an unpaid half hour.
    const shift = await raw.driverShift.create({
      data: {
        reference: `SHF-P${stamp}`,
        driverId,
        vehicleId,
        startedAt: new Date('2026-06-11T08:00:00Z'),
        endedAt: new Date('2026-06-11T16:00:00Z'),
        breakMinutes: 30,
        hourlyRatePence: 1700,
        approvedAt: new Date('2026-06-12T09:00:00Z'),
      },
    });
    shiftId = shift.id;

    // One job inside the shift — the company's car, so no driver fee — and
    // one in the driver's own time.
    const inShift = await raw.job.create({
      data: {
        reference: `PJ${stamp}A`,
        jobType: 'TRANSFER',
        status: 'COMPLETED',
        scheduledAt: new Date('2026-06-11T10:00:00Z'),
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow T5',
        driverId,
        vehicleId,
        shiftId,
        clientPricePence: 40000,
        driverPricePence: 24000,
      },
    });
    shiftJobId = inShift.id;

    const ownCar = await raw.job.create({
      data: {
        reference: `PJ${stamp}B`,
        jobType: 'TRANSFER',
        status: 'COMPLETED',
        scheduledAt: new Date('2026-06-13T10:00:00Z'),
        pickupText: 'The Savoy',
        dropoffText: 'Gatwick',
        driverId,
        clientPricePence: 30000,
        driverPricePence: 18000,
      },
    });
    ownJobId = ownCar.id;

    // A week's hire at £80 a day, half settled in cash.
    const rental = await raw.vehicleRental.create({
      data: {
        reference: `RNT-P${stamp}`,
        vehicleId,
        driverId,
        startAt: new Date('2026-06-15T09:00:00Z'),
        endAt: new Date('2026-06-22T09:00:00Z'),
        returnedAt: new Date('2026-06-22T09:00:00Z'),
        rateType: 'DAILY',
        ratePence: 8000,
        status: 'RETURNED',
      },
    });
    rentalId = rental.id;

    await raw.rentalPayment.create({
      data: {
        rentalId,
        amountPence: 28000,
        paidAt: new Date('2026-06-16T09:00:00Z'),
      },
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driverPayoutLine.deleteMany({ where: { payoutId } });
    await raw.driverPayout.deleteMany({ where: { id: payoutId } });
    await raw.invoiceLine.deleteMany({ where: { invoiceId } });
    await raw.invoice.deleteMany({ where: { id: invoiceId } });
    await raw.rentalPayment.deleteMany({ where: { rentalId } });
    await raw.vehicleRental.deleteMany({ where: { id: rentalId } });
    await raw.job.deleteMany({ where: { id: { in: [shiftJobId, ownJobId] } } });
    await raw.driverShift.deleteMany({ where: { id: shiftId } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  it('drafts a payout holding both a shift and a job', async () => {
    const draft = await draftPayout(driverId, PERIOD);

    // 7.5 paid hours at £17 = £127.50, plus the £180 job in the driver's
    // own car. The £240 job inside the shift is not paid again.
    expect(draft.shiftPence).toBe(12750);
    expect(draft.jobPence).toBe(18000);
    expect(draft.totalPence).toBe(30750);

    expect(draft.excluded.map((item) => item.reason)).toContainEqual(
      expect.stringMatching(/Covered by a shift/),
    );
  });

  it('persists a shift line, which the old schema could not hold', async () => {
    // `jobId` was NOT NULL, so an hourly driver had no way onto a payout at
    // all. This is the seam that had to open.
    const draft = await draftPayout(driverId, PERIOD);

    const payout = await raw!.driverPayout.create({
      data: {
        driverId,
        periodStart: PERIOD.from,
        periodEnd: PERIOD.to,
        totalPence: draft.totalPence,
        lines: {
          create: draft.lines.map((line) => ({
            jobId: line.jobId,
            shiftId: line.shiftId,
            amountPence: line.amountPence,
            description: line.description,
          })),
        },
      },
      include: { lines: true },
    });
    payoutId = payout.id;

    expect(payout.lines).toHaveLength(2);
    const shiftLine = payout.lines.find((line) => line.shiftId !== null);
    expect(shiftLine?.jobId).toBeNull();
    expect(shiftLine?.amountPence).toBe(12750);
  });

  it('refuses a payout line that is both a job and a shift', async () => {
    // Counted twice by anything grouping on either column.
    await expect(
      raw!.driverPayoutLine.create({
        data: { payoutId, jobId: ownJobId, shiftId, amountPence: 100 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a payout line that is neither', async () => {
    // Money owed for nothing.
    await expect(
      raw!.driverPayoutLine.create({
        data: { payoutId, amountPence: 100, description: 'from nowhere' },
      }),
    ).rejects.toThrow();
  });

  it('offers the rental for billing, net of cash already taken', async () => {
    const billable = await billableFor(PERIOD);

    const rentalItem = billable.items.find((item) => item.kind === 'RENTAL');
    expect(rentalItem).toBeDefined();
    // Seven days at £80 is £560; £280 already paid leaves £280.
    expect(rentalItem?.amountPence).toBe(28000);
    expect(rentalItem?.description).toContain(`PS${stamp}`);

    expect(billable.jobPence).toBeGreaterThan(0);
    expect(billable.rentalPence).toBe(28000);
  });

  it('bills a rental on an invoice line, and stops billing it twice', async () => {
    const invoice = await raw!.invoice.create({
      data: {
        number: `INV-P${stamp}`,
        issueDate: new Date('2026-07-01T00:00:00Z'),
        dueDate: new Date('2026-07-15T00:00:00Z'),
        netPence: 28000,
        vatPence: 5600,
        grossPence: 33600,
        lines: {
          create: [
            {
              rentalId,
              description: `Vehicle hire RNT-P${stamp}`,
              amountPence: 28000,
            },
          ],
        },
      },
      include: { lines: true },
    });
    invoiceId = invoice.id;

    expect(invoice.lines[0]?.rentalId).toBe(rentalId);
    expect(invoice.lines[0]?.jobId).toBeNull();

    // Now it is spoken for: shown, but no longer part of what is billable.
    const billable = await billableFor(PERIOD);
    const rentalItem = billable.items.find((item) => item.kind === 'RENTAL');
    expect(rentalItem?.alreadyInvoiced).toBe(true);
    expect(billable.rentalPence).toBe(0);
    expect(billable.invoicedPence).toBe(28000);
  });

  it('refuses an invoice line that is both a job and a rental', async () => {
    await expect(
      raw!.invoiceLine.create({
        data: {
          invoiceId,
          jobId: ownJobId,
          rentalId,
          description: 'both',
          amountPence: 100,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows a free-text invoice line that is neither', async () => {
    // A charge the system does not model is legitimate; it just cannot claim
    // to be a job or a hire.
    const line = await raw!.invoiceLine.create({
      data: { invoiceId, description: 'Agreed goodwill discount', amountPence: -500 },
    });
    expect(line.jobId).toBeNull();
    expect(line.rentalId).toBeNull();
  });

  it('counts rental income as revenue whether or not it was billed', async () => {
    // A report answers a different question from an invoice: a hire settled
    // in cash is still revenue.
    const revenue = await revenueFor(PERIOD);

    expect(revenue.rentalPence).toBe(56000);
    expect(revenue.rentalCount).toBe(1);
    expect(revenue.jobPence).toBeGreaterThan(0);
    expect(revenue.totalPence).toBe(revenue.jobPence + revenue.rentalPence);
  });
});
