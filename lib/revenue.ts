import {
  billableItems,
  revenueForPeriod,
  type BillableJob,
  type BillableRental,
  type BillableSummary,
  type RevenueBreakdown,
} from './billable';
import { buildJobLine, buildRentalLine } from './invoice-lines';
import { financeAmountsFrom, jobEconomics } from './job-finance';
import { prisma } from './prisma';
import { rentalBalance, rentalCharge, renterName } from './rentals';

/**
 * Gathering what the company earned, from both sources.
 *
 * Job revenue and rental revenue, kept apart. Phase 4 builds the invoice
 * screens and the reports on top of this — what exists here is the part that
 * had to be right first, because rental income that reaches only the fleet
 * profit view is income nobody bills for.
 */

export interface RevenuePeriod {
  from: Date;
  to: Date;
}

/**
 * Everything outstanding that could go on an invoice.
 *
 * A rental appears for what is still owed after cash already taken, and a job
 * or rental already on an invoice line is shown but never re-billed.
 */
export async function billableFor(
  period: RevenuePeriod,
  filters: { clientId?: string; accountId?: string } = {},
): Promise<BillableSummary> {
  const [jobs, rentals] = await Promise.all([
    prisma.job.findMany({
      where: {
        scheduledAt: { gte: period.from, lte: period.to },
        status: 'COMPLETED',
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.accountId ? { accountId: filters.accountId } : {}),
      },
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        clientId: true,
        accountId: true,
        clientPricePence: true,
        driverPricePence: true,
        shiftId: true,
        finance: true,
        stops: { select: { chargePence: true } },
        // `kind` is what says whether a recharged expense is a pass-through:
        // parking and drop-off charges belong on the invoice but out of the
        // tax base.
        expenses: { select: { kind: true, amountPence: true, borneBy: true } },
        invoiceLines: { select: { id: true }, take: 1 },
        // The facts the picker and the invoice line both need.
        jobType: true,
        contractEndsAt: true,
        pickupText: true,
        dropoffText: true,
        viaText: true,
        passengerName: true,
        flightNumber: true,
        vatTreatment: true,
        client: { select: { name: true, vatTreatment: true } },
        account: { select: { vatTreatment: true } },
        driver: { select: { name: true } },
      },
    }),
    // Only when no client or account filter is set: a hire is billed to the
    // driver renting the car, not to a client, so filtering by client would
    // silently drop every rental rather than returning none of them on
    // purpose.
    filters.clientId || filters.accountId
      ? Promise.resolve([])
      : prisma.vehicleRental.findMany({
          where: {
            startAt: { lte: period.to },
            status: { notIn: ['CANCELLED', 'BOOKED'] },
          },
          select: {
            id: true,
            reference: true,
            startAt: true,
            endAt: true,
            returnedAt: true,
            rateType: true,
            ratePence: true,
            depositPence: true,
            depositReturnedPence: true,
            damageChargePence: true,
            driverId: true,
            renterType: true,
            vatTreatment: true,
            driver: { select: { name: true } },
            account: { select: { name: true, vatTreatment: true } },
            hirerName: true,
            vehicle: { select: { registration: true, make: true, model: true } },
            payments: { select: { amountPence: true } },
            invoiceLines: { select: { id: true }, take: 1 },
          },
        }),
  ]);

  const billableJobs: BillableJob[] = jobs.map((job) => {
    const finance = financeAmountsFrom(job.finance);
    const economics = jobEconomics({
      finance,
      clientPricePence: job.clientPricePence,
      driverPricePence: job.driverPricePence,
      stops: job.stops,
      expenses: job.expenses,
      paidByShift: Boolean(job.shiftId),
    });
    return {
      id: job.id,
      reference: job.reference,
      occurredAt: job.scheduledAt,
      totalPence: economics.totalClientPence,
      clientId: job.clientId,
      accountId: job.accountId,
      invoicedLineId: job.invoiceLines[0]?.id ?? null,
      jobType: job.jobType,
      pickupText: job.pickupText,
      dropoffText: job.dropoffText,
      clientName: job.client?.name ?? null,
      driverName: job.driver?.name ?? null,
      line: buildJobLine({
        job: { ...job, finance },
        amountPence: economics.totalClientPence,
      }),
    };
  });

  const billableRentals: BillableRental[] = rentals.map((rental) => {
    const balance = rentalBalance(rental, rental.payments);
    const outstanding = balance.totalPence - balance.paidPence;
    return {
      id: rental.id,
      reference: rental.reference,
      // The hire is earned across its period; dated by its start so it lands
      // in the period an operator would expect to find it in.
      occurredAt: rental.startAt,
      totalPence: balance.totalPence,
      paidPence: balance.paidPence,
      driverId: rental.driverId,
      renterName: renterName(rental),
      vehicleRegistration: rental.vehicle.registration,
      invoicedLineId: rental.invoiceLines[0]?.id ?? null,
      line: buildRentalLine({
        rental,
        renterName: renterName(rental),
        periods: balance.periods,
        amountPence: outstanding,
      }),
    };
  });

  return billableItems({ jobs: billableJobs, rentals: billableRentals });
}

/**
 * What was earned in a period, invoiced or not.
 *
 * Different from `billableFor` on purpose: a report counts revenue whether or
 * not anyone has billed for it, so a hire already settled in cash still
 * counts here and does not appear there.
 */
export async function revenueFor(
  period: RevenuePeriod,
): Promise<RevenueBreakdown> {
  const [jobs, rentals] = await Promise.all([
    prisma.job.findMany({
      where: {
        scheduledAt: { gte: period.from, lte: period.to },
        status: 'COMPLETED',
      },
      select: {
        clientPricePence: true,
        driverPricePence: true,
        shiftId: true,
        finance: true,
        stops: { select: { chargePence: true } },
        expenses: { select: { amountPence: true, borneBy: true } },
      },
    }),
    prisma.vehicleRental.findMany({
      where: {
        startAt: { gte: period.from, lte: period.to },
        status: { not: 'CANCELLED' },
      },
      select: {
        startAt: true,
        endAt: true,
        returnedAt: true,
        rateType: true,
        ratePence: true,
        damageChargePence: true,
      },
    }),
  ]);

  return revenueForPeriod({
    jobs: jobs.map((job) => ({
      totalPence: jobEconomics({
        finance: financeAmountsFrom(job.finance),
        clientPricePence: job.clientPricePence,
        driverPricePence: job.driverPricePence,
        stops: job.stops,
        expenses: job.expenses,
        paidByShift: Boolean(job.shiftId),
      }).totalClientPence,
    })),
    rentals: rentals.map((rental) => ({
      totalPence: rentalCharge(rental).totalPence,
    })),
  });
}
