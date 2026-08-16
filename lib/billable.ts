import { sumPence } from './money';

/**
 * Everything the company can bill for a period, from both sources.
 *
 * Revenue does not only come from jobs. A company car out on hire earns while
 * it is out, and until now that income reached the per-vehicle profit view
 * and nowhere else — not an invoice, not a report. A rental that cannot be
 * invoiced is one somebody chases by hand, or does not chase at all.
 *
 * The two are kept as separate lines throughout rather than summed into one
 * "revenue" figure. A company earning well from hire and badly from jobs is
 * in a different position from one earning evenly, and a blended total hides
 * which it is.
 *
 * Pure, so the arithmetic can be tested without a database.
 */

export type BillableKind = 'JOB' | 'RENTAL';

export interface BillableJob {
  id: string;
  reference: string;
  occurredAt: Date;
  /** Everything the client was charged, recharged expenses included. */
  totalPence: number;
  clientId: string | null;
  accountId: string | null;
  /** Already on an invoice — billing it again would double-charge. */
  invoicedLineId?: string | null;
}

export interface BillableRental {
  id: string;
  reference: string;
  occurredAt: Date;
  /** Charge for the hire, damage included. */
  totalPence: number;
  /** Already settled in cash; only the remainder is worth invoicing. */
  paidPence: number;
  /**
   * The renter. Null when the hire went to a company or to somebody with no
   * record on the fleet — both are still billable, and `renterName` is what
   * an invoice line shows either way.
   */
  driverId: string | null;
  renterName: string;
  vehicleRegistration: string;
  invoicedLineId?: string | null;
}

export interface BillableItem {
  kind: BillableKind;
  id: string;
  reference: string;
  description: string;
  occurredAt: Date;
  amountPence: number;
  alreadyInvoiced: boolean;
}

export interface BillableSummary {
  items: BillableItem[];
  jobPence: number;
  rentalPence: number;
  totalPence: number;
  /** Already on an invoice, so shown but never re-billed. */
  invoicedPence: number;
}

/**
 * Turn jobs and rentals into one ordered list of billable items.
 *
 * A rental is billed for what is still outstanding, not its full charge: a
 * driver who has already paid £400 of a £560 hire in cash owes £160, and
 * invoicing the full amount would ask for money twice.
 */
export function billableItems(input: {
  jobs: BillableJob[];
  rentals: BillableRental[];
}): BillableSummary {
  const items: BillableItem[] = [];

  for (const job of input.jobs) {
    items.push({
      kind: 'JOB',
      id: job.id,
      reference: job.reference,
      description: `Job ${job.reference}`,
      occurredAt: job.occurredAt,
      amountPence: job.totalPence,
      alreadyInvoiced: Boolean(job.invoicedLineId),
    });
  }

  for (const rental of input.rentals) {
    const outstanding = rental.totalPence - rental.paidPence;
    // A fully-settled hire is not a debt. It still belongs in revenue, but
    // there is nothing left to invoice, so it is excluded rather than shown
    // as a zero line somebody has to think about.
    if (outstanding <= 0) continue;

    items.push({
      kind: 'RENTAL',
      id: rental.id,
      reference: rental.reference,
      description: `Vehicle hire ${rental.reference} — ${rental.vehicleRegistration}, ${rental.renterName}`,
      occurredAt: rental.occurredAt,
      amountPence: outstanding,
      alreadyInvoiced: Boolean(rental.invoicedLineId),
    });
  }

  items.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const billable = items.filter((item) => !item.alreadyInvoiced);
  const jobPence = sumPence(
    ...billable.filter((i) => i.kind === 'JOB').map((i) => i.amountPence),
  );
  const rentalPence = sumPence(
    ...billable.filter((i) => i.kind === 'RENTAL').map((i) => i.amountPence),
  );

  return {
    items,
    jobPence,
    rentalPence,
    totalPence: jobPence + rentalPence,
    invoicedPence: sumPence(
      ...items.filter((i) => i.alreadyInvoiced).map((i) => i.amountPence),
    ),
  };
}

/**
 * The revenue figure a report shows for a period.
 *
 * Deliberately different from `billableItems`: a report counts what was
 * *earned*, whether or not it has been invoiced or paid, so a fully-settled
 * hire still counts and an unpaid one is not counted twice.
 */
export interface RevenueBreakdown {
  jobPence: number;
  rentalPence: number;
  totalPence: number;
  jobCount: number;
  rentalCount: number;
}

export function revenueForPeriod(input: {
  jobs: Array<{ totalPence: number }>;
  rentals: Array<{ totalPence: number }>;
}): RevenueBreakdown {
  const jobPence = sumPence(...input.jobs.map((job) => job.totalPence));
  const rentalPence = sumPence(...input.rentals.map((rental) => rental.totalPence));

  return {
    jobPence,
    rentalPence,
    totalPence: jobPence + rentalPence,
    jobCount: input.jobs.length,
    rentalCount: input.rentals.length,
  };
}
