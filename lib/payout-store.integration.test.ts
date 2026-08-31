import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvePayout,
  createPayout,
  deletePayout,
  draftFor,
  markPayoutPaid,
} from './payout-store';

/**
 * Payouts against a real database.
 *
 * Three things only this can prove, and each of them is money:
 *
 * - a job appears on one payout and one only, even across overlapping periods
 * - approving-and-paying flips every job it covers *and* the payout in one
 *   transaction, so a half-applied payment is impossible
 * - a driver-paid expense is reimbursed on top of the fee, not instead of it
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-8);

/** A period of its own, so these never collide with seeded jobs. */
const FROM = new Date('2117-04-01T00:00:00.000Z');
const TO = new Date('2117-04-30T23:59:59.999Z');

describe.skipIf(!DATABASE_AVAILABLE)('driver payouts', () => {
  let driverId = '';
  let vehicleId = '';
  const jobIds: string[] = [];
  const payoutIds: string[] = [];

  async function makeJob(
    reference: string,
    driverPricePence: number | null,
    scheduledAt: Date,
  ) {
    const job = await raw!.job.create({
      data: {
        reference,
        scheduledAt,
        status: 'COMPLETED',
        jobType: 'TRANSFER',
        pickupText: 'Mayfair',
        dropoffText: 'Heathrow Terminal 5',
        clientPricePence: 15000,
        driverPricePence,
        driverId,
        vehicleId,
      },
      select: { id: true },
    });
    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (!raw) return;

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `PY${stamp.slice(-5)}`,
        normalisedRegistration: `PY${stamp.slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
      },
      select: { id: true },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-P${stamp}`,
        name: `Payout Driver ${stamp}`,
        phone: `0770${stamp}`,
        assignedVehicleId: vehicleId,
      },
      select: { id: true },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driverPayoutLine.deleteMany({
      where: { payoutId: { in: payoutIds } },
    });
    await raw.driverPayout.deleteMany({ where: { driverId } });
    await raw.jobExpense.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  it('drafts a payout from completed jobs', async () => {
    await makeJob(`PJOB-${stamp}-1`, 8000, new Date('2117-04-05T09:00:00Z'));
    await makeJob(`PJOB-${stamp}-2`, 9500, new Date('2117-04-06T09:00:00Z'));

    const draft = await draftFor(driverId, { from: FROM, to: TO });
    expect(draft.lines).toHaveLength(2);
    expect(draft.totalPence).toBe(17_500);

    const result = await createPayout(driverId, { from: FROM, to: TO }, audit);
    expect(result.ok).toBe(true);
    if (result.ok) payoutIds.push(result.id);

    const payout = await raw!.driverPayout.findUniqueOrThrow({
      where: { id: payoutIds[0]! },
      include: { lines: true },
    });
    expect(payout.totalPence).toBe(17_500);
    expect(payout.lines).toHaveLength(2);
    expect(payout.status).toBe('DRAFT');
  });

  it('never puts a job on a second payout', async () => {
    // Spec 4.5.4. Two operators drafting overlapping periods on the same
    // afternoon is exactly how a driver gets paid twice.
    const overlapping = {
      from: new Date('2117-04-01T00:00:00.000Z'),
      to: new Date('2117-04-15T23:59:59.999Z'),
    };

    const draft = await draftFor(driverId, overlapping);
    expect(draft.lines).toEqual([]);
    expect(draft.excluded.map((item) => item.reason)).toContain(
      'Already on another payout',
    );

    const second = await createPayout(driverId, overlapping, audit);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('NOTHING_TO_PAY');
  });

  it('refuses a second payout for the same period', async () => {
    const again = await createPayout(driverId, { from: FROM, to: TO }, audit);
    expect(again.ok).toBe(false);
    // Either refusal is correct — nothing is left to pay *and* the period is
    // taken. What must not happen is a second payout existing.
    const count = await raw!.driverPayout.count({ where: { driverId } });
    expect(count).toBe(1);
  });

  it('refuses to mark a draft paid before it is approved', async () => {
    const result = await markPayoutPaid(
      payoutIds[0]!,
      { paidAt: new Date('2117-05-01T00:00:00Z'), paymentReference: null },
      audit,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_APPROVED');
  });

  it('flips every covered job to fully paid, in one transaction', async () => {
    // Spec 4.5.3. Two statements outside a transaction is how a payout ends
    // up marked paid with half its jobs still reading unpaid — unresolvable
    // afterwards, because nobody can tell whether the money went out.
    const approved = await approvePayout(payoutIds[0]!, audit);
    expect(approved.ok).toBe(true);

    const paid = await markPayoutPaid(
      payoutIds[0]!,
      {
        paidAt: new Date('2117-05-01T00:00:00Z'),
        paymentReference: 'FPS-0001',
      },
      audit,
    );
    expect(paid.ok).toBe(true);

    const payout = await raw!.driverPayout.findUniqueOrThrow({
      where: { id: payoutIds[0]! },
      include: { lines: true },
    });
    expect(payout.status).toBe('PAID');
    expect(payout.paymentReference).toBe('FPS-0001');

    const covered = payout.lines
      .map((line) => line.jobId)
      .filter((id): id is string => id !== null);

    const finances = await raw!.jobFinance.findMany({
      where: { jobId: { in: covered } },
      select: { jobId: true, driverPayStatus: true, driverPaymentPence: true },
    });

    expect(finances).toHaveLength(covered.length);
    for (const finance of finances) {
      expect(finance.driverPayStatus).toBe('FULLY_PAID');
    }
  });

  it('refuses to pay the same payout twice', async () => {
    const again = await markPayoutPaid(
      payoutIds[0]!,
      { paidAt: new Date('2117-05-02T00:00:00Z'), paymentReference: null },
      audit,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('ALREADY_PAID');
  });

  it('refuses to discard anything but a draft', async () => {
    const discarded = await deletePayout(payoutIds[0]!, audit);
    expect(discarded.ok).toBe(false);
    if (!discarded.ok) expect(discarded.code).toBe('NOT_DRAFT');
  });

  it('reimburses an approved driver-paid expense on top of the fee', async () => {
    const period = {
      from: new Date('2117-06-01T00:00:00.000Z'),
      to: new Date('2117-06-30T23:59:59.999Z'),
    };

    const jobId = await makeJob(
      `PJOB-${stamp}-3`,
      8000,
      new Date('2117-06-05T09:00:00Z'),
    );

    await raw!.jobExpense.createMany({
      data: [
        {
          jobId,
          kind: 'PARKING',
          amountPence: 1200,
          submittedByDriverId: driverId,
          approvedAt: new Date('2117-06-06T00:00:00Z'),
          borneBy: 'COMPANY',
        },
        // Not reimbursed: the driver bears this one themselves, and paying it
        // back would cover the same cost twice.
        {
          jobId,
          kind: 'FUEL',
          amountPence: 4000,
          submittedByDriverId: driverId,
          approvedAt: new Date('2117-06-06T00:00:00Z'),
          borneBy: 'DRIVER',
        },
        // Not reimbursed: nobody has approved it.
        {
          jobId,
          kind: 'TOLL',
          amountPence: 500,
          submittedByDriverId: driverId,
          borneBy: 'COMPANY',
        },
      ],
    });

    const draft = await draftFor(driverId, period);
    expect(draft.jobPence).toBe(8000);
    expect(draft.expensePence).toBe(1200);
    expect(draft.totalPence).toBe(9200);
  });

  it('says what it left out rather than quietly dropping it', async () => {
    const period = {
      from: new Date('2117-07-01T00:00:00.000Z'),
      to: new Date('2117-07-31T23:59:59.999Z'),
    };

    await makeJob(`PJOB-${stamp}-4`, null, new Date('2117-07-05T09:00:00Z'));

    const draft = await draftFor(driverId, period);
    expect(draft.lines).toEqual([]);
    expect(draft.excluded[0]?.reason).toContain('No driver price');

    // And it refuses to draft rather than writing an empty payout somebody
    // would later take for a completed one.
    const result = await createPayout(driverId, period, audit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTHING_TO_PAY');
  });

  it('discards a draft, and its lines with it', async () => {
    const period = {
      from: new Date('2117-08-01T00:00:00.000Z'),
      to: new Date('2117-08-31T23:59:59.999Z'),
    };

    await makeJob(`PJOB-${stamp}-5`, 7000, new Date('2117-08-05T09:00:00Z'));

    const created = await createPayout(driverId, period, audit);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    payoutIds.push(created.id);

    const discarded = await deletePayout(created.id, audit);
    expect(discarded.ok).toBe(true);

    const lines = await raw!.driverPayoutLine.count({
      where: { payoutId: created.id },
    });
    expect(lines).toBe(0);

    // And the job is payable again: discarding a draft must not strand work.
    const draft = await draftFor(driverId, period);
    expect(draft.lines).toHaveLength(1);
  });
});
