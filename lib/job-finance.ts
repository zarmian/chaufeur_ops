import { z } from 'zod';
import { marginPct, roundPence, sumPence } from './money';

/**
 * The per-job finance arithmetic.
 *
 * The legacy system computed these totals in the browser and stored whatever
 * the browser sent, so a stale tab or a hand-edited field could persist a
 * gross profit that did not follow from its own inputs. Here the client may
 * calculate for feedback, but `calculateFinance` runs again on the server and
 * the server's answer is what gets written. The client never sends a total.
 *
 * Everything is integer pence. Hours are the one non-integer input — a
 * three-and-a-half hour booking is real — so the multiplication is done in
 * floating point and immediately rounded through `roundPence`, once, at the
 * point it becomes money.
 */

/**
 * Hours accept up to two decimals, matching `Decimal(5,2)` in the schema.
 *
 * An empty field becomes null, never 0. The distinction is real: null means
 * "not an hourly job", whereas 0 claims the job ran for no time and would
 * quietly zero an as-directed booking's revenue. The blank is mapped before
 * coercion because `z.coerce.number()` turns `''` into 0.
 */
const hours = z.preprocess(
  (value) =>
    value === '' || value === null || value === undefined ? null : value,
  z.coerce
    .number()
    .min(0, 'Hours cannot be negative')
    .max(999.99, 'That is more hours than a job can run')
    .nullable(),
);

/** Money fields arrive as pounds from the form and are stored as pence. */
const pence = z.coerce
  .number()
  .int('Enter a whole number of pence')
  .min(0, 'That cannot be negative')
  .max(100_000_000, 'That is larger than any realistic job')
  .default(0);

export const financeSchema = z.object({
  // Revenue
  baseFarePence: pence,
  waitTimePence: pence,
  waitMinutesBilled: z.coerce.number().int().min(0).max(24 * 60).default(0),
  extraChargesPence: pence,
  extraChargesNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  customerHours: hours,
  customerRatePence: pence,

  // Costs
  driverPaymentPence: pence,
  fuelCostPence: pence,
  otherExpensesPence: pence,
  expenseNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  driverHours: hours,
  driverRatePence: pence,

  // Settlement
  driverPayStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'FULLY_PAID']),
  driverPayMethod: z
    .enum(['CASH', 'CARD', 'BANK_TRANSFER', 'INVOICE'])
    .optional()
    .or(z.literal('')),
  driverPaidAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
    .optional()
    .or(z.literal('')),
  paymentNotes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type FinanceInput = z.infer<typeof financeSchema>;

export interface FinanceTotals {
  totalClientPence: number;
  totalCostsPence: number;
  grossProfitPence: number;
  /** Null when there is no revenue — see `marginPct`. */
  marginPct: number | null;
}

/**
 * The inputs the totals actually depend on. Narrower than `FinanceInput` so
 * the live preview in the browser and the authoritative server calculation
 * can call exactly the same function.
 */
export interface FinanceAmounts {
  baseFarePence?: number | null;
  waitTimePence?: number | null;
  extraChargesPence?: number | null;
  customerHours?: number | null;
  customerRatePence?: number | null;
  driverPaymentPence?: number | null;
  fuelCostPence?: number | null;
  otherExpensesPence?: number | null;
  driverHours?: number | null;
  driverRatePence?: number | null;
}

/**
 * Revenue, cost, gross profit and margin.
 *
 * Hourly charges are rounded to the penny before being added, not after, so
 * the stored total is the sum of amounts that could each be shown on an
 * invoice line. Rounding at the end instead would produce a total that no
 * combination of its own visible lines adds up to.
 */
export function calculateFinance(amounts: FinanceAmounts): FinanceTotals {
  const customerHourly = hourlyCharge(
    amounts.customerHours,
    amounts.customerRatePence,
  );
  const driverHourly = hourlyCharge(amounts.driverHours, amounts.driverRatePence);

  const totalClientPence = sumPence(
    amounts.baseFarePence,
    amounts.waitTimePence,
    amounts.extraChargesPence,
    customerHourly,
  );

  const totalCostsPence = sumPence(
    amounts.driverPaymentPence,
    amounts.fuelCostPence,
    amounts.otherExpensesPence,
    driverHourly,
  );

  const grossProfitPence = totalClientPence - totalCostsPence;

  return {
    totalClientPence,
    totalCostsPence,
    grossProfitPence,
    marginPct: marginPct(totalClientPence, grossProfitPence),
  };
}

/** `hours × rate`, rounded once, at the point it becomes money. */
export function hourlyCharge(
  hoursWorked: number | null | undefined,
  ratePence: number | null | undefined,
): number {
  if (!hoursWorked || !ratePence) return 0;
  return roundPence(hoursWorked * ratePence);
}

/**
 * What the finance panel shows when a job has a booking price but no finance
 * record yet (spec 2.5.5).
 *
 * The booking prices are the commercial agreement, so they seed the panel
 * rather than the panel starting empty and inviting someone to retype them —
 * retyping is where the two numbers drift apart.
 */
export function prefillFromBooking(job: {
  clientPricePence: number | null;
  driverPricePence: number | null;
}): FinanceAmounts {
  return {
    baseFarePence: job.clientPricePence ?? 0,
    driverPaymentPence: job.driverPricePence ?? 0,
  };
}

/**
 * Turn validated form input into the row to persist, with totals recomputed
 * here rather than trusted from the caller.
 */
export function toFinanceData(input: FinanceInput) {
  const totals = calculateFinance(input);

  return {
    baseFarePence: input.baseFarePence,
    waitTimePence: input.waitTimePence,
    waitMinutesBilled: input.waitMinutesBilled,
    extraChargesPence: input.extraChargesPence,
    extraChargesNotes: emptyToNull(input.extraChargesNotes),
    customerHours: input.customerHours,
    customerRatePence: input.customerRatePence,

    driverPaymentPence: input.driverPaymentPence,
    fuelCostPence: input.fuelCostPence,
    otherExpensesPence: input.otherExpensesPence,
    expenseNotes: emptyToNull(input.expenseNotes),
    driverHours: input.driverHours,
    driverRatePence: input.driverRatePence,

    totalClientPence: totals.totalClientPence,
    totalCostsPence: totals.totalCostsPence,
    grossProfitPence: totals.grossProfitPence,

    driverPayStatus: input.driverPayStatus,
    driverPayMethod: input.driverPayMethod ? input.driverPayMethod : null,
    driverPaidAt: input.driverPaidAt ? new Date(`${input.driverPaidAt}T00:00:00Z`) : null,
    paymentNotes: emptyToNull(input.paymentNotes),
  };
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Free waiting-time allowance before the clock starts billing.
 *
 * Airport arrivals get longer because the wait is largely outside the
 * passenger's control — immigration and baggage, not dawdling. Both are
 * configurable; these are the documented defaults.
 */
export const DEFAULT_FREE_WAIT_MINUTES = { airport: 45, other: 15 } as const;

export function freeWaitMinutesFor(
  jobType: string,
  overrides: { airport?: number; other?: number } = {},
): number {
  return jobType === 'AIRPORT_TRANSFER'
    ? overrides.airport ?? DEFAULT_FREE_WAIT_MINUTES.airport
    : overrides.other ?? DEFAULT_FREE_WAIT_MINUTES.other;
}

/**
 * Billable wait minutes, given the free allowance.
 *
 * Phase 5 feeds this from the gap between the driver's `ARRIVED` and `POB`
 * events. Until then the panel accepts a typed figure — but the rule for what
 * counts as billable lives here either way, so the two cannot disagree.
 */
export function billableWaitMinutes(
  waitedMinutes: number,
  freeMinutes: number,
): number {
  if (!Number.isFinite(waitedMinutes) || waitedMinutes <= 0) return 0;
  return Math.max(0, Math.floor(waitedMinutes - freeMinutes));
}
