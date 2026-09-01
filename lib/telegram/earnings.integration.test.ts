import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawPrismaClient } from '../raw-prisma';
import { currentPayoutWeek } from '../payout-period';
import { driverEarnings } from './earnings';

/**
 * The figure a driver is given, against real rows.
 *
 * The message itself is covered without a database in `./earnings.test.ts`.
 * What only this can prove is the part that would quietly go wrong: that
 * `/pay` counts the same work a payout would, and no other. A driver told a
 * number that does not match their statement has been given a reason to
 * distrust both, so the two have to be the same computation over the same
 * period — which is why this asserts on money that is *not* counted at least
 * as carefully as on money that is.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

describe.skipIf(!DATABASE_AVAILABLE)(
  'what a driver is told they have earned',
  () => {
    let driverId = '';
    let otherDriverId = '';
    const jobIds: string[] = [];
    const payoutIds: string[] = [];
    let made = 0;

    /*
     * Midday on the Monday of the week in progress.
     *
     * Anchored to the week rather than to `now` because the assertions are
     * about what falls inside it: a fixture at `now + 2h` lands in next week
     * when the suite runs late on a Sunday evening, and the failure then looks
     * like an earnings bug rather than a calendar one.
     */
    const week = currentPayoutWeek(new Date(), 'Europe/London');
    const insideWeek = new Date(week.from.getTime() + 12 * 60 * 60 * 1000);
    const beforeWeek = new Date(week.from.getTime() - 36 * 60 * 60 * 1000);

    beforeAll(async () => {
      if (!raw) return;

      const driver = await raw.driver.create({
        data: {
          reference: `EA-${stamp}-1`,
          name: `Earnings Driver ${stamp}`,
          phone: `07700${stamp}1`,
          status: 'ACTIVE',
          telegramChatId: BigInt(700_000_001),
        },
      });
      driverId = driver.id;

      const other = await raw.driver.create({
        data: {
          reference: `EA-${stamp}-2`,
          name: `Other Driver ${stamp}`,
          phone: `07700${stamp}2`,
          status: 'ACTIVE',
        },
      });
      otherDriverId = other.id;
    });

    afterAll(async () => {
      if (!raw) return;
      await raw.driverPayoutLine.deleteMany({
        where: { payoutId: { in: payoutIds } },
      });
      await raw.driverPayout.deleteMany({ where: { id: { in: payoutIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
      await raw.driver.deleteMany({
        where: { id: { in: [driverId, otherDriverId] } },
      });
      await raw.$disconnect();
    });

    async function makeJob(options: {
      driverId: string;
      scheduledAt: Date;
      status: string;
      driverPricePence: number | null;
    }): Promise<string> {
      made += 1;
      const job = await raw!.job.create({
        data: {
          reference: `EJ-${stamp}-${made}`,
          jobType: 'TRANSFER',
          status: options.status as never,
          scheduledAt: options.scheduledAt,
          pickupText: 'The Dorchester',
          dropoffText: 'Heathrow Terminal 5',
          clientPricePence: 14_500,
          driverPricePence: options.driverPricePence,
          driverId: options.driverId,
        },
      });
      jobIds.push(job.id);
      return job.id;
    }

    it('counts completed work in the week and nothing else', async () => {
      await makeJob({
        driverId,
        scheduledAt: insideWeek,
        status: 'COMPLETED',
        driverPricePence: 9000,
      });
      // Booked but not run: not earned yet, whatever it is worth.
      await makeJob({
        driverId,
        scheduledAt: insideWeek,
        status: 'ASSIGNED',
        driverPricePence: 7500,
      });
      // Last week's work belongs on last week's statement.
      await makeJob({
        driverId,
        scheduledAt: beforeWeek,
        status: 'COMPLETED',
        driverPricePence: 6000,
      });

      const earnings = await driverEarnings(driverId);

      expect(earnings.jobCount).toBe(1);
      expect(earnings.soFar.jobPence).toBe(9000);
      expect(earnings.soFar.totalPence).toBe(9000);
    });

    it("never counts another driver's work", async () => {
      // The one failure that would be a data leak rather than a wrong total.
      await makeJob({
        driverId: otherDriverId,
        scheduledAt: insideWeek,
        status: 'COMPLETED',
        driverPricePence: 25_000,
      });

      const earnings = await driverEarnings(driverId);
      expect(earnings.soFar.totalPence).toBe(9000);

      const theirs = await driverEarnings(otherDriverId);
      expect(theirs.soFar.totalPence).toBe(25_000);
    });

    it('names an unpriced job rather than dropping it from the total', async () => {
      // A job worth nothing is a defect, and a driver who cannot see it has no
      // way to ask about it.
      const unpriced = await makeJob({
        driverId,
        scheduledAt: insideWeek,
        status: 'COMPLETED',
        driverPricePence: null,
      });

      const earnings = await driverEarnings(driverId);
      const job = await raw!.job.findUniqueOrThrow({
        where: { id: unpriced },
        select: { reference: true },
      });

      expect(earnings.soFar.totalPence).toBe(9000);
      expect(earnings.soFar.excluded).toContainEqual(
        expect.objectContaining({ reference: job.reference, code: 'UNPRICED' }),
      );
    });

    it('stops counting work once a payout has taken it', async () => {
      /*
       * The assertion that keeps `/pay` honest across a Monday.
       *
       * Once the office drafts the statement, the week's jobs are on it. If
       * `/pay` went on adding them up, a driver would see the same money twice
       * — once as "this week so far" and once as a statement — and reasonably
       * conclude they were owed both.
       */
      const paid = await makeJob({
        driverId,
        scheduledAt: insideWeek,
        status: 'COMPLETED',
        driverPricePence: 4000,
      });

      const before = await driverEarnings(driverId);
      expect(before.soFar.totalPence).toBe(13_000);

      const payout = await raw!.driverPayout.create({
        data: {
          driverId,
          periodStart: week.from,
          periodEnd: week.to,
          totalPence: 13_000,
          status: 'APPROVED',
          lines: {
            create: [{ jobId: paid, amountPence: 4000, description: 'Job' }],
          },
        },
      });
      payoutIds.push(payout.id);

      const after = await driverEarnings(driverId);
      expect(after.soFar.totalPence).toBe(9000);
      expect(after.soFar.excluded).toContainEqual(
        expect.objectContaining({ code: 'ALREADY_PAID' }),
      );
    });

    it('reports the latest statement and what is approved but unpaid', async () => {
      const earnings = await driverEarnings(driverId);

      expect(earnings.latest).toMatchObject({
        totalPence: 13_000,
        status: 'APPROVED',
        paidAt: null,
      });
      expect(earnings.awaitingPayment.map((row) => row.totalPence)).toEqual([
        13_000,
      ]);
    });

    it('drops a statement out of “waiting to be paid” once it is paid', async () => {
      await raw!.driverPayout.update({
        where: { id: payoutIds[0] },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paymentReference: `FPS-${stamp}`,
        },
      });

      const earnings = await driverEarnings(driverId);
      expect(earnings.awaitingPayment).toHaveLength(0);
      expect(earnings.latest).toMatchObject({
        status: 'PAID',
        paymentReference: `FPS-${stamp}`,
      });
    });
  },
);
