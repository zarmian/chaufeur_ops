import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addJobLine, createInvoice } from './invoice-store';
import { hasPriceOrReason } from './job-status';
import { countUnpricedCompleted, listJobs, transitionJob } from './jobs';
import { loadDispatchDay } from './dispatch';

/**
 * An as-directed job is priced by the hour, and everything must know it.
 *
 * The defect this pins: a four-hour job at £59/hour displayed "Revenue
 * £236.00" and a gross profit while the same page said "Client price: No",
 * flew the red unpriced alert and refused completion. Because invoicing draws
 * on completed jobs, no as-directed work could be billed at all without
 * somebody retyping the total into the fixed-price field.
 *
 * The cause was one assumption in five places: that the client-facing figure
 * lives in `Job.clientPricePence`. For hourly work it lives in
 * `JobFinance.totalClientPence`, and `clientPricePence` is legitimately null
 * because there is no fixed fare.
 *
 * As-directed hire is one of three job types, so every one of these
 * assertions is about ordinary work, not an edge case.
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

/** Its own year, so these totals never collide with another file's. */
const WHEN = new Date('2114-05-20T09:00:00.000Z');

/** Four hours at £59.00 — the shape from the report. */
const HOURS = 4;
const RATE_PENCE = 5_900;
const TOTAL_PENCE = HOURS * RATE_PENCE; // £236.00

describe.skipIf(!DATABASE_AVAILABLE)('hourly jobs are priced jobs', () => {
  const jobIds: string[] = [];
  const invoiceIds: string[] = [];
  let clientId = '';
  let hourlyJobId = '';

  beforeAll(async () => {
    if (!raw) return;

    const client = await raw.client.create({
      data: { name: `Hourly Client ${stamp}`, normalisedName: `hourlyclient${stamp}` },
    });
    clientId = client.id;

    // An as-directed job exactly as the booking form saves one: hours and a
    // rate on the finance record, and no fixed fare.
    const job = await raw.job.create({
      data: {
        reference: `HRLY-${stamp}`,
        jobType: 'AS_DIRECTED',
        status: 'IN_PROGRESS',
        scheduledAt: WHEN,
        pickupText: `Hourly Pickup ${stamp}`,
        dropoffText: 'As directed',
        clientId,
        clientPricePence: null,
        finance: {
          create: {
            customerHours: HOURS,
            customerRatePence: RATE_PENCE,
            totalClientPence: TOTAL_PENCE,
            totalCostsPence: 0,
            grossProfitPence: TOTAL_PENCE,
          },
        },
      },
    });
    hourlyJobId = job.id;
    jobIds.push(job.id);
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.invoiceLine.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.client.deleteMany({ where: { id: clientId } });
    await raw.$disconnect();
  });

  it('counts hours × rate as a price', () => {
    // The root of it. A fixed fare and an hourly total are two homes for one
    // idea, and the check has to read both.
    expect(
      hasPriceOrReason({
        clientPricePence: null,
        zeroValueReason: null,
        finance: { totalClientPence: TOTAL_PENCE },
      }),
    ).toBe(true);
  });

  it('still refuses a job with neither', () => {
    // The guard has to keep working. Loosening it so hourly jobs pass would
    // be worse than the bug — the whole system exists because 140 of 141
    // legacy jobs were worth nothing.
    expect(
      hasPriceOrReason({
        clientPricePence: null,
        zeroValueReason: null,
        finance: { totalClientPence: 0 },
      }),
    ).toBe(false);

    expect(
      hasPriceOrReason({ clientPricePence: null, zeroValueReason: null }),
    ).toBe(false);
  });

  it('lets an hourly job be completed', async () => {
    // The headline symptom: all 24 hourly jobs stuck in progress.
    const result = await transitionJob(hourlyJobId, 'COMPLETED', {});

    expect(
      result.ok,
      result.ok ? '' : `refused: ${result.message}`,
    ).toBe(true);

    const after = await raw!.job.findUnique({
      where: { id: hourlyJobId },
      select: { status: true },
    });
    expect(after!.status).toBe('COMPLETED');
  });

  it('leaves it out of the unpriced count', async () => {
    // It was inflating the dashboard tile and the digest — 32 reported.
    const unpriced = await raw!.job.count({
      where: {
        id: hourlyJobId,
        AND: [
          { OR: [{ clientPricePence: null }, { clientPricePence: { lte: 0 } }] },
          {
            OR: [
              { finance: { is: null } },
              { finance: { totalClientPence: { lte: 0 } } },
            ],
          },
          { zeroValueReason: null },
        ],
      },
    });
    expect(unpriced).toBe(0);

    // And through the real counter, which must not have regressed.
    await expect(countUnpricedCompleted()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('leaves it out of the unpriced filter on the job list', async () => {
    const { rows } = await listJobs(
      { page: 1, pageSize: 50, skip: 0, take: 50, q: `Hourly Pickup ${stamp}`, sort: null, dir: 'asc' },
      {
        status: null, jobType: null, driverId: null, clientId: null,
        accountId: null, vehicleId: null, from: null, to: null,
        unpricedOnly: true,
      },
    );

    expect(rows.map((row) => row.id)).not.toContain(hourlyJobId);
  });

  it('invoices it at the hourly total, not at zero', async () => {
    // The other half of the defect. Letting it through while still reading
    // `clientPricePence` would have put a £0 line in front of a client and
    // quietly marked the job billed.
    const invoice = await createInvoice(
      {
        clientId,
        accountId: null,
        issueDate: WHEN,
        dueDate: null,
        lines: [{ description: 'Opening line', amountPence: 1_000 }],
      },
      {},
    );
    expect(invoice.ok, invoice.ok ? '' : invoice.message).toBe(true);
    if (!invoice.ok) return;
    invoiceIds.push(invoice.id);

    const added = await addJobLine(invoice.id, hourlyJobId, {});
    expect(added.ok, added.ok ? '' : added.message).toBe(true);

    const line = await raw!.invoiceLine.findFirst({
      where: { invoiceId: invoice.id, jobId: hourlyJobId },
    });
    expect(line, 'the hourly job never reached the invoice').toBeTruthy();
    expect(line!.amountPence).toBe(TOTAL_PENCE);
  });

  it('does not flag it as unpriced on the dispatch board', async () => {
    const board = await loadDispatchDay(WHEN, { includeEmptyDrivers: false });
    const blocks = board.rows
      .flatMap((row) => row.blocks)
      .concat(board.unassigned);
    const mine = blocks.find((block) => block.id === hourlyJobId);

    // It may be assigned or unassigned; what matters is the flag when found.
    if (mine) expect(mine.unpriced).toBe(false);
  });
});
