import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getVehicleCosts,
  recordStandingCost,
  recordVehicleCost,
  standingCostSchema,
  vehicleCostSchema,
  vehicleProfit,
} from './fleet';
import { createJob, jobSchema } from './jobs';

/**
 * The fleet profit view against a real database.
 *
 * The arithmetic is unit-tested; what only this proves is that the right rows
 * are gathered for a window — jobs by scheduled time, rentals by the period
 * they held the car, standing costs pro-rata — and that a driver-owned car
 * genuinely refuses a cost entry rather than merely hiding it.
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

function dayIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

const WINDOW = {
  from: new Date(Date.now() - 200 * 86_400_000),
  to: new Date(Date.now() + 200 * 86_400_000),
};

describe.skipIf(!DATABASE_AVAILABLE)('fleet profit', () => {
  let companyCarId = '';
  let driverCarId = '';
  let driverId = '';
  const jobIds: string[] = [];

  beforeAll(async () => {
    if (!raw) return;
    await raw.$connect();

    const stamp = String(Date.now()).slice(-6);
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);

    const company = await raw.vehicle.create({
      data: {
        registration: `FC${stamp}`,
        normalisedRegistration: `FC${stamp}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        seats: 4,
        ownership: 'FINANCED',
        motExpiry: far,
        insuranceExpiry: far,
        phvLicenceExpiry: far,
      },
    });
    companyCarId = company.id;

    const owned = await raw.vehicle.create({
      data: {
        registration: `DO${stamp}`,
        normalisedRegistration: `DO${stamp}`,
        make: 'Toyota',
        model: 'Prius',
        vehicleClass: 'SALOON',
        seats: 4,
        ownership: 'DRIVER_OWNED',
        motExpiry: far,
        insuranceExpiry: far,
        phvLicenceExpiry: far,
      },
    });
    driverCarId = owned.id;

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-F${stamp}`,
        name: 'Fleet Driver',
        phone: `07700${stamp}`,
        dvlaLicenceExpiry: far,
        phvBadgeExpiry: far,
      },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    if (jobIds.length > 0) {
      await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    for (const id of [companyCarId, driverCarId].filter(Boolean)) {
      await raw.vehicleCost.deleteMany({ where: { vehicleId: id } });
      await raw.vehicleStandingCost.deleteMany({ where: { vehicleId: id } });
    }
    if (driverId) await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({
      where: { id: { in: [companyCarId, driverCarId].filter(Boolean) } },
    });
    await raw.$disconnect();
  });

  async function bookJobOn(vehicleId: string, price: string, driverPrice: string) {
    const job = await createJob(
      jobSchema.parse({
        jobType: 'TRANSFER',
        scheduledDate: dayIn(3),
        scheduledTime: '14:30',
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow T5',
        driverId,
        vehicleId,
        clientPricePence: price,
        driverPricePence: driverPrice,
      }),
      audit,
    );
    jobIds.push(job.id);
    return job;
  }

  it('nets a repair off the revenue of a company car', async () => {
    await bookJobOn(companyCarId, '400.00', '240.00');

    const result = await recordVehicleCost(
      companyCarId,
      vehicleCostSchema.parse({
        kind: 'REPAIR',
        amountPence: '120.00',
        incurredOn: dayIn(-5),
        supplier: 'Local garage',
        odometer: '41200',
      }),
      audit,
    );
    expect(result.ok).toBe(true);

    const profit = await vehicleProfit(companyCarId, WINDOW);
    expect(profit?.pnl.jobRevenuePence).toBe(40000);
    expect(profit?.pnl.driverPayPence).toBe(24000);
    expect(profit?.pnl.runningCostPence).toBe(12000);
    expect(profit?.pnl.profitPence).toBe(40000 - 24000 - 12000);
  });

  it('spreads an annual premium rather than charging it whole', async () => {
    const result = await recordStandingCost(
      companyCarId,
      standingCostSchema.parse({
        kind: 'INSURANCE',
        label: 'Fleet policy',
        amountPence: '1200.00',
        periodMonths: '12',
        startsOn: dayIn(-30),
      }),
      audit,
    );
    expect(result.ok).toBe(true);

    // One month of the window, so about one twelfth of the premium.
    const month = {
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(Date.now() - 1 * 86_400_000),
    };
    const profit = await vehicleProfit(companyCarId, month);
    expect(profit?.pnl.standingCostPence).toBeGreaterThan(8000);
    expect(profit?.pnl.standingCostPence).toBeLessThan(12000);
  });

  it('refuses a cost against a driver-owned car', async () => {
    // Recording it would understate that car's margin and overstate what the
    // company spends — two wrong numbers from one mistake.
    const result = await recordVehicleCost(
      driverCarId,
      vehicleCostSchema.parse({
        kind: 'REPAIR',
        amountPence: '120.00',
        incurredOn: dayIn(-5),
      }),
      audit,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/belongs to its driver/);
  });

  it('refuses a standing cost against a driver-owned car too', async () => {
    const result = await recordStandingCost(
      driverCarId,
      standingCostSchema.parse({
        kind: 'INSURANCE',
        label: 'Their policy',
        amountPence: '600.00',
        periodMonths: '12',
        startsOn: dayIn(-30),
      }),
      audit,
    );
    expect(result.ok).toBe(false);
  });

  it('shows a driver-owned car’s margin with no running costs', async () => {
    await bookJobOn(driverCarId, '300.00', '200.00');

    const profit = await vehicleProfit(driverCarId, WINDOW);
    expect(profit?.pnl.jobRevenuePence).toBe(30000);
    expect(profit?.pnl.driverPayPence).toBe(20000);
    expect(profit?.pnl.runningCostPence).toBe(0);
    expect(profit?.pnl.standingCostPence).toBe(0);
    expect(profit?.pnl.costsCounted).toBe(false);
    expect(profit?.pnl.profitPence).toBe(10000);
  });

  it('records a service and moves the last-serviced marks', async () => {
    // Otherwise every service would have to be entered twice.
    await recordVehicleCost(
      companyCarId,
      vehicleCostSchema.parse({
        kind: 'SERVICE',
        amountPence: '350.00',
        incurredOn: dayIn(-2),
        odometer: '42000',
      }),
      audit,
    );

    const vehicle = await raw!.vehicle.findUniqueOrThrow({
      where: { id: companyCarId },
    });
    expect(vehicle.lastServicedOn).not.toBeNull();
    expect(vehicle.lastServiceMiles).toBe(42000);
    expect(vehicle.currentOdometer).toBe(42000);
  });

  it('never winds the odometer backwards on a late invoice', async () => {
    await recordVehicleCost(
      companyCarId,
      vehicleCostSchema.parse({
        kind: 'TYRES',
        amountPence: '400.00',
        incurredOn: dayIn(-60),
        odometer: '38000',
      }),
      audit,
    );

    const vehicle = await raw!.vehicle.findUniqueOrThrow({
      where: { id: companyCarId },
    });
    expect(vehicle.currentOdometer).toBe(42000);
  });

  it('refuses a receipt it cannot actually store', async () => {
    // Said plainly rather than dropping the file. The operator watched it
    // upload; silently discarding it would only surface at the VAT return.
    const configured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    const result = await recordVehicleCost(
      companyCarId,
      vehicleCostSchema.parse({
        kind: 'REPAIR',
        amountPence: '90.00',
        incurredOn: dayIn(-3),
      }),
      audit,
      {
        buffer: Buffer.from('a receipt'),
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
      },
    );

    if (configured) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/storage is not configured/);
    }
  });

  it('records a cost with no receipt at all', async () => {
    // The receipt is optional throughout — a cost entered from a bank line
    // with no paperwork yet is still a cost.
    const result = await recordVehicleCost(
      companyCarId,
      vehicleCostSchema.parse({
        kind: 'CLEANING',
        amountPence: '25.00',
        incurredOn: dayIn(-4),
      }),
      audit,
    );
    expect(result.ok).toBe(true);

    const { costs } = await getVehicleCosts(companyCarId);
    const cleaning = costs.find((cost) => cost.kind === 'CLEANING');
    expect(cleaning?.receiptFileKey).toBeNull();
  });

  it('lists the costs and the service position', async () => {
    const { costs, standing, service } = await getVehicleCosts(companyCarId);
    expect(costs.length).toBeGreaterThan(0);
    expect(standing.length).toBeGreaterThan(0);
    expect(service).not.toBeNull();
  });

  it('excludes a job outside the window', async () => {
    const narrow = {
      from: new Date(Date.now() + 100 * 86_400_000),
      to: new Date(Date.now() + 200 * 86_400_000),
    };
    const profit = await vehicleProfit(companyCarId, narrow);
    expect(profit?.pnl.jobRevenuePence).toBe(0);
  });
});
