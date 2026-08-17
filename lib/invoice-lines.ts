import { formatDateTime } from './dates';
import { unitCharge } from './job-finance';
import { RATE_TYPE_UNIT } from './rentals';
import {
  disbursementPenceOf,
  resolveVatTreatment,
  type VatTreatment,
} from './vat';

/**
 * What an invoice line says, and how much of it is taxable.
 *
 * The complaint this exists for: an invoice listed nothing but job numbers.
 * "WLX-000767 — Heathrow T3 to Marylebone" tells the person paying it
 * approximately nothing, and reconciling one against a diary meant opening
 * every job in turn. A line now carries the same facts the jobs list shows —
 * when, what kind of work, where from, where to — as a title and a short block
 * of detail beneath it.
 *
 * The text is **stored** on the line rather than derived from the job when the
 * document renders. An invoice that has been sent is a document somebody else
 * is holding; correcting a typo in a pickup address must not silently change
 * their copy. So this builds the snapshot once, when the line is added.
 *
 * Pure: everything it needs arrives as an argument.
 */

/** A line ready to persist. Mirrors the columns on `InvoiceLine`. */
export interface BuiltLine {
  description: string;
  amountPence: number;
  disbursementPence: number;
  vatTreatment: VatTreatment;
  quantity: number | null;
  quantityUnit: string | null;
  unitPricePence: number | null;
}

const JOB_TYPE_LABELS: Record<string, string> = {
  TRANSFER: 'Transfer',
  AIRPORT_TRANSFER: 'Airport transfer',
  AS_DIRECTED: 'As directed',
  CONTRACT: 'Contract hire',
};

export function jobTypeLabel(jobType: string): string {
  return JOB_TYPE_LABELS[jobType] ?? jobType;
}

/**
 * The description block for a job, as lines.
 *
 * First entry is the title; the rest is detail. Kept as an array so callers
 * that render HTML and callers that store a string agree on the split, rather
 * than one of them re-parsing the other's newlines.
 */
export function jobLineText(job: {
  reference: string;
  jobType: string;
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  viaText?: string | null;
  passengerName?: string | null;
  flightNumber?: string | null;
}): string[] {
  return [
    `${jobTypeLabel(job.jobType)} · ${job.reference}`,
    formatDateTime(job.scheduledAt),
    `Pick up: ${job.pickupText}`,
    ...(job.viaText ? [`Via: ${job.viaText}`] : []),
    `Drop off: ${job.dropoffText}`,
    ...(job.flightNumber ? [`Flight: ${job.flightNumber}`] : []),
    ...(job.passengerName ? [`Passenger: ${job.passengerName}`] : []),
  ];
}

export function joinLineText(parts: string[]): string {
  return parts.join('\n');
}

/** Title and detail back out of a stored description. */
export function splitLineText(description: string): {
  title: string;
  details: string[];
} {
  const [title = '', ...details] = description.split('\n');
  return { title, details: details.filter((line) => line.trim() !== '') };
}

export interface JobLineInput {
  job: {
    reference: string;
    jobType: string;
    scheduledAt: Date;
    pickupText: string;
    dropoffText: string;
    viaText?: string | null;
    passengerName?: string | null;
    flightNumber?: string | null;
    vatTreatment?: VatTreatment | null;
    account?: { vatTreatment?: VatTreatment | null } | null;
    client?: { vatTreatment?: VatTreatment | null } | null;
    finance?: {
      customerHours?: number | null;
      customerRatePence?: number | null;
      customerDays?: number | null;
      customerDayRatePence?: number | null;
    } | null;
    expenses?: Array<{ kind: string; amountPence: number; borneBy: string }>;
  };
  /** What the job comes to in total, from `jobEconomics`. */
  amountPence: number;
}

/**
 * One job as an invoice line.
 *
 * The quantity columns follow how the work was actually priced. An as-directed
 * job bills hours × rate and shows both, because "10 hrs at £140" is what the
 * client agreed and a bare £1,400 invites a phone call. A transfer is one
 * trip at a fixed fare. Anything that does not resolve cleanly shows no
 * quantity at all rather than an invented "1 × " — see the column comment on
 * `InvoiceLine.quantity`.
 */
export function buildJobLine(input: JobLineInput): BuiltLine {
  const { job } = input;

  const treatment = resolveVatTreatment(
    job.vatTreatment,
    job.account?.vatTreatment,
    job.client?.vatTreatment,
  );

  // Parking and drop-off charges recharged to the client are on the invoice
  // but out of the tax base.
  const disbursementPence = disbursementPenceOf(job.expenses ?? []);

  const hours = job.finance?.customerHours ?? null;
  const rate = job.finance?.customerRatePence ?? null;
  const days = job.finance?.customerDays ?? null;
  const dayRate = job.finance?.customerDayRatePence ?? null;

  // The quantity columns are shown only when the figure multiplies out to the
  // whole charge. A job billed for days *and* extra charges cannot honestly
  // print "5 days at £400" beside a larger total, so it prints the total
  // alone — the client would query the difference otherwise.
  const priced =
    job.jobType === 'CONTRACT' &&
    days !== null &&
    dayRate !== null &&
    unitCharge(days, dayRate) === input.amountPence
      ? { quantity: days, unit: days === 1 ? 'day' : 'days', rate: dayRate }
      : job.jobType === 'AS_DIRECTED' &&
          hours !== null &&
          rate !== null &&
          unitCharge(hours, rate) === input.amountPence
        ? { quantity: hours, unit: 'hrs', rate }
        : { quantity: 1, unit: 'trip', rate: input.amountPence };

  return {
    description: joinLineText(jobLineText(job)),
    amountPence: input.amountPence,
    disbursementPence,
    vatTreatment: treatment,
    quantity: priced.quantity,
    quantityUnit: priced.unit,
    unitPricePence: priced.rate,
  };
}

export interface RentalLineInput {
  rental: {
    reference: string;
    startAt: Date;
    endAt: Date;
    rateType: string;
    ratePence: number;
    vatTreatment?: VatTreatment | null;
    account?: { vatTreatment?: VatTreatment | null } | null;
    vehicle: { registration: string; make?: string | null; model?: string | null };
  };
  renterName: string;
  /** Chargeable periods, from `chargeablePeriods`. */
  periods: number;
  /** What is still owed, from `rentalBalance`. */
  amountPence: number;
}

/**
 * One hire as an invoice line.
 *
 * Quantity columns only when the outstanding amount is exactly periods × rate.
 * A hire part-settled in cash, or carrying a damage charge, is billed for the
 * remainder — and "26 days at £200" beside a figure that is not £5,200 is a
 * line the client will query.
 */
export function buildRentalLine(input: RentalLineInput): BuiltLine {
  const { rental } = input;
  const unit = RATE_TYPE_UNIT[rental.rateType as keyof typeof RATE_TYPE_UNIT] ?? 'day';
  const car = [rental.vehicle.make, rental.vehicle.model].filter(Boolean).join(' ');
  const straightforward = input.periods * rental.ratePence === input.amountPence;

  return {
    description: joinLineText([
      `Vehicle hire · ${rental.reference}`,
      [car, rental.vehicle.registration].filter(Boolean).join(' — '),
      `${formatDateTime(rental.startAt)} to ${formatDateTime(rental.endAt)}`,
      `Hirer: ${input.renterName}`,
    ]),
    amountPence: input.amountPence,
    // A hire is a supply of the operator's own car. Nothing about it is
    // passed through.
    disbursementPence: 0,
    vatTreatment: resolveVatTreatment(
      rental.vatTreatment,
      rental.account?.vatTreatment,
    ),
    quantity: straightforward ? input.periods : null,
    quantityUnit: straightforward ? `${unit}s` : null,
    unitPricePence: straightforward ? rental.ratePence : null,
  };
}
