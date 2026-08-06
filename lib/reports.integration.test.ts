import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financeAmountsFrom, jobEconomics } from './job-finance';
import { sumPence } from './money';
import {
  reportBreakdown,
  reportDetail,
  reportSummary,
  reportTrend,
  type ReportFilters,
} from './reports';

/**
 * Report totals reconcile with the records underneath them — spec 4.6.9.
 *
 * This is the test the whole reporting module exists to pass. The aggregates
 * are computed in SQL for speed, and `jobEconomics` computes the same figures
 * in TypeScript for the finance panel and the invoice. Two implementations of
 * one rule drift, and a report that disagrees with the job it is built from
 * is worse than no report — so this sums the records the slow, obvious way
 * and asserts the SQL matches to the penny.
 *
 * The fixtures deliberately cover every branch of the expression: a job with
 * a finance record and one without, stops, all three expense bearers, hourly
 * work, and a shift-paid job whose driver fee must not be counted.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const stamp = String(Date.now()).slice(-8);

/**
 * A year of its own, so neither seeded jobs nor another test file's fixtures
 * can leak into these totals.
 *
 * It has to be exclusive, not merely far away. These assertions compare an
 * unfiltered total to a filtered one, so a single job from another test file
 * landing in this window makes them disagree — and because Vitest runs files
 * in parallel, that shows up as an intermittent failure rather than a
 * consistent one. `dispatch.integration.test.ts` used to sit in 2119 and did
 * exactly that; it now has 2117.
 */
const FROM = new Date('2119-01-01T00:00:00.000Z');
const TO = new Date('2119-12-31T23:59:59.999Z');

const filters: ReportFilters = { from: FROM, to: TO };

describe.skipIf(!DATABASE_AVAILABLE)('report reconciliation', () => {
  const jobIds: string[] = [];
  let driverId = '';
  let vehicleId = '';
  let clientId = '';
  let shiftId = '';

  beforeAll(async () => {
    if (!raw) return;

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `RP${stamp.slice(-5)}`,
        normalisedRegistration: `RP${stamp.slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
      },
      select: { id: true },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-R${stamp}`,
        name: `Report Driver ${stamp}`,
        phone: `0771${stamp}`,
        assignedVehicleId: vehicleId,
      },
      select: { id: true },
    });
    driverId = driver.id;

    const client = await raw.client.create({
      data: { name: `Report Client ${stamp}`, normalisedName: `reportclient${stamp}` },
      select: { id: true },
    });
    clientId = client.id;

    const shift = await raw.driverShift.create({
      data: {
        reference: `SHF-R${stamp}`,
        driverId,
        vehicleId,
        startedAt: new Date('2119-03-01T08:00:00Z'),
        endedAt: new Date('2119-03-01T16:00:00Z'),
        hourlyRatePence: 1800,
      },
      select: { id: true },
    });
    shiftId = shift.id;

    async function job(
      suffix: string,
      data: Record<string, unknown>,
    ): Promise<string> {
      const created = await raw!.job.create({
        data: {
          reference: `RJOB-${stamp}-${suffix}`,
          scheduledAt: new Date('2119-03-01T09:00:00Z'),
          status: 'COMPLETED',
          jobType: 'TRANSFER',
          pickupText: 'Mayfair',
          dropoffText: 'Heathrow Terminal 5',
          driverId,
          vehicleId,
          clientId,
          ...data,
        },
        select: { id: true },
      });
      jobIds.push(created.id);
      return created.id;
    }

    // 1. Booking prices only — no finance record. The booking price stands in.
    await job('1', { clientPricePence: 12_000, driverPricePence: 8000 });

    // 2. A finance record, which wins over the booking price even where they
    //    disagree. Waiting and extras are revenue; fuel is a cost.
    const withFinance = await job('2', {
      clientPricePence: 12_000,
      driverPricePence: 8000,
    });
    await raw.jobFinance.create({
      data: {
        jobId: withFinance,
        baseFarePence: 14_000,
        waitTimePence: 2250,
        extraChargesPence: 500,
        driverPaymentPence: 9000,
        fuelCostPence: 1500,
        otherExpensesPence: 300,
      },
    });

    // 3. Stops and all three expense bearers at once.
    const withExtras = await job('3', {
      clientPricePence: 20_000,
      driverPricePence: 12_000,
    });
    await raw.jobStop.createMany({
      data: [
        { jobId: withExtras, sequence: 1, address: 'Knightsbridge', chargePence: 1500 },
        { jobId: withExtras, sequence: 2, address: 'Chelsea', chargePence: 2500 },
      ],
    });
    await raw.jobExpense.createMany({
      data: [
        // Recharged: revenue.
        { jobId: withExtras, kind: 'PARKING', amountPence: 900, borneBy: 'CLIENT' },
        // Ours: a cost.
        { jobId: withExtras, kind: 'TOLL', amountPence: 400, borneBy: 'COMPANY' },
        // The driver's own: neither.
        { jobId: withExtras, kind: 'FUEL', amountPence: 5000, borneBy: 'DRIVER' },
      ],
    });

    // 4. Hourly work, where the money is hours times rate rather than a fare.
    const hourly = await job('4', { jobType: 'AS_DIRECTED', clientPricePence: null });
    await raw.jobFinance.create({
      data: {
        jobId: hourly,
        baseFarePence: 0,
        customerHours: 4.5,
        customerRatePence: 4500,
        driverHours: 4.5,
        driverRatePence: 2200,
      },
    });

    // 5. Paid by the shift, so the driver fee must not be counted here.
    await job('5', {
      clientPricePence: 9000,
      driverPricePence: 6000,
      shiftId,
    });

    // 6. Unpriced. Counted, and its absence of revenue must not become a
    //    silent zero somewhere.
    await job('6', { clientPricePence: null, driverPricePence: 4000 });

    // 7. Cancelled, which is never revenue and must be excluded by default.
    await job('7', {
      status: 'CANCELLED',
      clientPricePence: 99_999,
      driverPricePence: 0,
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobExpense.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobStop.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driverShift.deleteMany({ where: { id: shiftId } });
    await raw.client.deleteMany({ where: { id: clientId } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  /** The same totals, computed the slow and obvious way. */
  async function byHand() {
    const jobs = await raw!.job.findMany({
      where: {
        id: { in: jobIds },
        status: { not: 'CANCELLED' },
      },
      select: {
        clientPricePence: true,
        driverPricePence: true,
        shiftId: true,
        finance: true,
        stops: { select: { chargePence: true } },
        expenses: { select: { amountPence: true, borneBy: true } },
      },
    });

    const economics = jobs.map((job) =>
      jobEconomics({
        finance: financeAmountsFrom(job.finance),
        clientPricePence: job.clientPricePence,
        driverPricePence: job.driverPricePence,
        stops: job.stops,
        expenses: job.expenses,
        paidByShift: Boolean(job.shiftId),
      }),
    );

    return {
      jobs: jobs.length,
      revenuePence: sumPence(...economics.map((e) => e.totalClientPence)),
      costsPence: sumPence(...economics.map((e) => e.totalCostsPence)),
      profitPence: sumPence(...economics.map((e) => e.grossProfitPence)),
    };
  }

  it('totals exactly what the underlying records add up to', async () => {
    const [sql, hand] = await Promise.all([reportSummary(filters), byHand()]);

    expect(sql.jobs).toBe(hand.jobs);
    expect(sql.revenuePence).toBe(hand.revenuePence);
    expect(sql.costsPence).toBe(hand.costsPence);
    expect(sql.profitPence).toBe(hand.profitPence);
  });

  it('leaves cancelled work out, because it is not revenue', async () => {
    const summary = await reportSummary(filters);
    // The cancelled fixture is £999.99. If it leaked in, the total would be
    // unmistakably wrong rather than subtly so.
    expect(summary.revenuePence).toBeLessThan(99_999);
    expect(summary.jobs).toBe(6);
  });

  it('counts the unpriced job, so the revenue figure can be read honestly', async () => {
    const summary = await reportSummary(filters);
    expect(summary.unpricedJobs).toBe(1);
  });

  it('charges no driver cost on a shift-paid job', async () => {
    const shiftOnly = await reportSummary({ ...filters, driverId });
    const withoutShift = await reportDetail(
      { ...filters },
      { skip: 0, take: 100 },
    );

    const paidByShift = withoutShift.rows.find((row) =>
      row.reference.endsWith('-5'),
    );
    expect(paidByShift).toBeDefined();
    // £90 of revenue, and nothing on the cost side: the £60 fee is paid
    // through the shift, and counting it here would pay for it twice.
    expect(paidByShift?.revenuePence).toBe(9000);
    expect(paidByShift?.costsPence).toBe(0);
    expect(shiftOnly.jobs).toBe(6);
  });

  it('breaks down by every dimension without changing the total', async () => {
    const summary = await reportSummary(filters);

    for (const dimension of [
      'jobType',
      'client',
      'account',
      'driver',
      'vehicle',
    ] as const) {
      const rows = await reportBreakdown(filters, dimension);
      const revenue = sumPence(...rows.map((row) => row.revenuePence));
      const costs = sumPence(...rows.map((row) => row.costsPence));
      const jobs = rows.reduce((total, row) => total + row.jobs, 0);

      expect(revenue, `${dimension} revenue`).toBe(summary.revenuePence);
      expect(costs, `${dimension} costs`).toBe(summary.costsPence);
      expect(jobs, `${dimension} job count`).toBe(summary.jobs);
    }
  });

  it('bucket totals over the months add up to the whole', async () => {
    const [summary, trend] = await Promise.all([
      reportSummary(filters),
      reportTrend(filters),
    ]);

    expect(sumPence(...trend.map((point) => point.revenuePence))).toBe(
      summary.revenuePence,
    );
    expect(sumPence(...trend.map((point) => point.profitPence))).toBe(
      summary.profitPence,
    );
  });

  it('the detail rows add up to the summary', async () => {
    const [summary, detail] = await Promise.all([
      reportSummary(filters),
      reportDetail(filters, { skip: 0, take: 500 }),
    ]);

    expect(detail.total).toBe(summary.jobs);
    expect(sumPence(...detail.rows.map((row) => row.revenuePence))).toBe(
      summary.revenuePence,
    );
    expect(sumPence(...detail.rows.map((row) => row.costsPence))).toBe(
      summary.costsPence,
    );
  });

  it('paginates without losing or repeating a row', async () => {
    const all = await reportDetail(filters, { skip: 0, take: 500 });
    const first = await reportDetail(filters, { skip: 0, take: 3 });
    const second = await reportDetail(filters, { skip: 3, take: 3 });

    expect(first.rows).toHaveLength(3);
    expect(first.total).toBe(all.total);

    const seen = new Set([
      ...first.rows.map((row) => row.id),
      ...second.rows.map((row) => row.id),
    ]);
    expect(seen.size).toBe(first.rows.length + second.rows.length);
  });

  it('narrows to one client without changing that client’s figures', async () => {
    const [all, one] = await Promise.all([
      reportSummary(filters),
      reportSummary({ ...filters, clientId }),
    ]);

    // Every fixture is on this client, so the filter must be a no-op here —
    // which is the point: a filter that quietly changed a total would be
    // worse than one that returned nothing.
    expect(one.revenuePence).toBe(all.revenuePence);
    expect(one.jobs).toBe(all.jobs);
  });
});
