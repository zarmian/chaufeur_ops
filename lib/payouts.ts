import { financeAmountsFrom, jobEconomics } from './job-finance';
import {
  buildPayoutLines,
  type PayoutDraft,
  type PayoutJob,
  type PayoutShift,
} from './payout-lines';
import { prisma } from './prisma';
import { shiftPayPence } from './shifts';

/**
 * Gathering what a driver is owed.
 *
 * The arithmetic and the "never pay twice" rule live in
 * `lib/payout-lines.ts`; this module's job is to fetch the right rows. Phase 4
 * builds the payout screens and the PDF statement on top of it — what exists
 * here is the part that had to be right before those could be written at all,
 * because a payout that cannot hold a shift cannot pay an hourly driver.
 */

export interface PayoutPeriod {
  from: Date;
  to: Date;
}

/**
 * A driver's draft payout for a period.
 *
 * Completed work only. A job still in progress has not earned its fee, and a
 * shift still open has no end to compute pay from.
 */
export async function draftPayout(
  driverId: string,
  period: PayoutPeriod,
): Promise<PayoutDraft> {
  const [jobs, shifts] = await Promise.all([
    prisma.job.findMany({
      where: {
        driverId,
        scheduledAt: { gte: period.from, lte: period.to },
        status: 'COMPLETED',
      },
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        driverPricePence: true,
        shiftId: true,
      },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.driverShift.findMany({
      where: {
        driverId,
        startedAt: { gte: period.from, lte: period.to },
      },
      select: {
        id: true,
        reference: true,
        startedAt: true,
        endedAt: true,
        breakMinutes: true,
        hourlyRatePence: true,
        approvedAt: true,
      },
      orderBy: { startedAt: 'asc' },
    }),
  ]);

  const payoutJobs: PayoutJob[] = jobs.map((job) => ({
    id: job.id,
    reference: job.reference,
    scheduledAt: job.scheduledAt,
    driverPricePence: job.driverPricePence,
    shiftId: job.shiftId,
  }));

  const payoutShifts: PayoutShift[] = shifts.map((shift) => ({
    id: shift.id,
    reference: shift.reference,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    payPence: shiftPayPence(shift),
    approvedAt: shift.approvedAt,
  }));

  return buildPayoutLines({ jobs: payoutJobs, shifts: payoutShifts });
}

/**
 * Everything already paid out for a job or a shift.
 *
 * Used to keep a record off a second payout. The unique index on
 * `(driverId, periodStart, periodEnd)` stops a period being drafted twice,
 * but not a job being dragged into an adjacent one.
 */
export async function alreadyPaidOut(ids: {
  jobIds?: string[];
  shiftIds?: string[];
}): Promise<{ jobIds: Set<string>; shiftIds: Set<string> }> {
  const lines = await prisma.driverPayoutLine.findMany({
    where: {
      OR: [
        ...(ids.jobIds?.length ? [{ jobId: { in: ids.jobIds } }] : []),
        ...(ids.shiftIds?.length ? [{ shiftId: { in: ids.shiftIds } }] : []),
      ],
      payout: { status: { not: 'DRAFT' } },
    },
    select: { jobId: true, shiftId: true },
  });

  return {
    jobIds: new Set(
      lines.map((line) => line.jobId).filter((id): id is string => id !== null),
    ),
    shiftIds: new Set(
      lines.map((line) => line.shiftId).filter((id): id is string => id !== null),
    ),
  };
}

/**
 * What a job is worth to the company, for the revenue side.
 *
 * Shares `jobEconomics` with the finance panel and the fleet profit view, so
 * a job is worth the same everywhere it is counted.
 */
export async function jobRevenueFor(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;

  const jobs = await prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: {
      clientPricePence: true,
      driverPricePence: true,
      shiftId: true,
      finance: true,
      stops: { select: { chargePence: true } },
      expenses: { select: { amountPence: true, borneBy: true } },
    },
  });

  return jobs.reduce((total, job) => {
    const economics = jobEconomics({
      finance: financeAmountsFrom(job.finance),
      clientPricePence: job.clientPricePence,
      driverPricePence: job.driverPricePence,
      stops: job.stops,
      expenses: job.expenses,
      paidByShift: Boolean(job.shiftId),
    });
    return total + economics.totalClientPence;
  }, 0);
}
