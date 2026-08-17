import { z } from 'zod';
import { daysBetweenDates } from './dates';
import { DEFAULT_TIMEZONE } from './locale';
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

/**
 * Days accept two decimals, matching `Decimal(6,2)`. A half day is a real
 * arrangement; a blank is null rather than zero, for the same reason hours are
 * — zero days would silently zero a contract's revenue.
 */
const days = z.preprocess(
  (value) =>
    value === '' || value === null || value === undefined ? null : value,
  z.coerce
    .number()
    .min(0, 'Days cannot be negative')
    .max(9999.99, 'That is more days than a contract can run')
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
  /**
   * Set when an accountant is deliberately replacing a figure the driver's
   * taps produced — spec 5.5.4. Recorded because "why is this £12 rather than
   * the £25 the clock says" is the question somebody will ask in six months,
   * and the answer must not be "somebody typed it".
   */
  waitOverrideReason: z.string().trim().max(500).optional().or(z.literal('')),
  extraChargesPence: pence,
  extraChargesNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  customerHours: hours,
  customerRatePence: pence,
  // Contract work. `days` rather than `hours` so the message an operator
  // sees names what they typed.
  customerDays: days,
  customerDayRatePence: pence,

  // Costs
  driverPaymentPence: pence,
  fuelCostPence: pence,
  otherExpensesPence: pence,
  expenseNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  driverHours: hours,
  driverRatePence: pence,
  driverDays: days,
  driverDayRatePence: pence,

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
  /** Contract work, charged by the day rather than by the hour. */
  customerDays?: number | null;
  customerDayRatePence?: number | null;
  driverPaymentPence?: number | null;
  fuelCostPence?: number | null;
  otherExpensesPence?: number | null;
  driverHours?: number | null;
  driverRatePence?: number | null;
  driverDays?: number | null;
  driverDayRatePence?: number | null;
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

  // Contract work. Added rather than chosen between: a contract with a
  // standing day rate can still run over on one of its days, and the extra
  // hours are billed on top of the day — not instead of it.
  const customerDaily = unitCharge(
    amounts.customerDays,
    amounts.customerDayRatePence,
  );
  const driverDaily = unitCharge(amounts.driverDays, amounts.driverDayRatePence);

  const totalClientPence = sumPence(
    amounts.baseFarePence,
    amounts.waitTimePence,
    amounts.extraChargesPence,
    customerHourly,
    customerDaily,
  );

  const totalCostsPence = sumPence(
    amounts.driverPaymentPence,
    amounts.fuelCostPence,
    amounts.otherExpensesPence,
    driverHourly,
    driverDaily,
  );

  const grossProfitPence = totalClientPence - totalCostsPence;

  return {
    totalClientPence,
    totalCostsPence,
    grossProfitPence,
    marginPct: marginPct(totalClientPence, grossProfitPence),
  };
}

/** `quantity × rate`, rounded once, at the point it becomes money. */
export function unitCharge(
  quantity: number | null | undefined,
  ratePence: number | null | undefined,
): number {
  if (!quantity || !ratePence) return 0;
  return roundPence(quantity * ratePence);
}

/** `hours × rate`. Named for its caller; the arithmetic is `unitCharge`. */
export function hourlyCharge(
  hoursWorked: number | null | undefined,
  ratePence: number | null | undefined,
): number {
  return unitCharge(hoursWorked, ratePence);
}

/** `days × day rate`, for contract work. */
export function dailyCharge(
  days: number | null | undefined,
  dayRatePence: number | null | undefined,
): number {
  return unitCharge(days, dayRatePence);
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
    customerDays: input.customerDays,
    customerDayRatePence: input.customerDayRatePence,

    driverPaymentPence: input.driverPaymentPence,
    fuelCostPence: input.fuelCostPence,
    otherExpensesPence: input.otherExpensesPence,
    expenseNotes: emptyToNull(input.expenseNotes),
    driverHours: input.driverHours,
    driverRatePence: input.driverRatePence,
    driverDays: input.driverDays,
    driverDayRatePence: input.driverDayRatePence,

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
 * Everything that moves a job's money, beyond the finance panel's own fields.
 *
 * Phase 2's totals came only from the panel. Three things were missing, and
 * each of them changes the answer:
 *
 * - **Stop charges** are revenue the panel never saw.
 * - **Itemised expenses** split three ways by who bears them. Recharged ones
 *   are revenue; company-borne ones are cost; driver-borne ones are neither,
 *   and counting them would understate profit on every owner-driver job.
 * - **Shift-paid work.** When a hired driver's time is covered by a shift,
 *   the job has no driver payment of its own. Leaving the panel's figure in
 *   would double-count the driver, or — worse, and more likely — leave a
 *   stale per-job fee sitting on a job nobody was paid per-job for.
 */
export interface JobEconomicsInput {
  finance: FinanceAmounts | null;
  /** Falls back to the booking price when no finance record exists yet. */
  clientPricePence?: number | null;
  driverPricePence?: number | null;
  stops?: Array<{ chargePence: number | null }>;
  expenses?: Array<{ amountPence: number; borneBy: 'CLIENT' | 'COMPANY' | 'DRIVER' }>;
  /** True when a shift covers the driver's pay for this job. */
  paidByShift?: boolean;
}

export interface JobEconomics extends FinanceTotals {
  stopChargePence: number;
  rechargedExpensePence: number;
  companyExpensePence: number;
  driverBorneExpensePence: number;
  paidByShift: boolean;
}

/**
 * A stored `JobFinance` row as plain numbers.
 *
 * `customerHours` and `driverHours` come back from Prisma as `Decimal`, which
 * is right for the column and wrong for arithmetic here — everything else is
 * integer pence and hours are the one fractional input. Converting in one
 * place stops a `Decimal` reaching a multiplication and silently
 * stringifying.
 */
export function financeAmountsFrom(
  row: {
    baseFarePence: number;
    waitTimePence: number;
    extraChargesPence: number;
    customerHours: { toNumber(): number } | number | null;
    customerRatePence: number;
    customerDays?: { toNumber(): number } | number | null;
    customerDayRatePence?: number;
    driverPaymentPence: number;
    fuelCostPence: number;
    otherExpensesPence: number;
    driverHours: { toNumber(): number } | number | null;
    driverRatePence: number;
    driverDays?: { toNumber(): number } | number | null;
    driverDayRatePence?: number;
  } | null,
): FinanceAmounts | null {
  if (!row) return null;
  return {
    baseFarePence: row.baseFarePence,
    waitTimePence: row.waitTimePence,
    extraChargesPence: row.extraChargesPence,
    customerHours: toNumber(row.customerHours),
    customerRatePence: row.customerRatePence,
    customerDays: toNumber(row.customerDays ?? null),
    customerDayRatePence: row.customerDayRatePence ?? 0,
    driverPaymentPence: row.driverPaymentPence,
    fuelCostPence: row.fuelCostPence,
    otherExpensesPence: row.otherExpensesPence,
    driverHours: toNumber(row.driverHours),
    driverRatePence: row.driverRatePence,
    driverDays: toNumber(row.driverDays ?? null),
    driverDayRatePence: row.driverDayRatePence ?? 0,
  };
}

function toNumber(value: { toNumber(): number } | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

export function jobEconomics(input: JobEconomicsInput): JobEconomics {
  const stopChargePence = sumPence(
    ...(input.stops ?? []).map((stop) => stop.chargePence),
  );

  const expenses = input.expenses ?? [];
  const by = (bearer: 'CLIENT' | 'COMPANY' | 'DRIVER') =>
    sumPence(
      ...expenses
        .filter((expense) => expense.borneBy === bearer)
        .map((expense) => expense.amountPence),
    );

  const rechargedExpensePence = by('CLIENT');
  const companyExpensePence = by('COMPANY');
  const driverBorneExpensePence = by('DRIVER');

  // With no finance record the booking prices stand in, so a job priced at
  // the phone and never opened in the panel still reports honestly.
  const amounts: FinanceAmounts = input.finance ?? {
    baseFarePence: input.clientPricePence ?? 0,
    driverPaymentPence: input.driverPricePence ?? 0,
  };

  const base = calculateFinance({
    ...amounts,
    // Driver pay lives on the shift, not here.
    ...(input.paidByShift ? { driverPaymentPence: 0, driverHours: null } : {}),
  });

  const totalClientPence =
    base.totalClientPence + stopChargePence + rechargedExpensePence;
  const totalCostsPence = base.totalCostsPence + companyExpensePence;
  const grossProfitPence = totalClientPence - totalCostsPence;

  return {
    totalClientPence,
    totalCostsPence,
    grossProfitPence,
    marginPct: marginPct(totalClientPence, grossProfitPence),
    stopChargePence,
    rechargedExpensePence,
    companyExpensePence,
    driverBorneExpensePence,
    paidByShift: Boolean(input.paidByShift),
  };
}

/**
 * Billed hours for an as-directed job.
 *
 * The minimum-hours rule is the point (spec 2.5.6.2): a two-hour booking on a
 * four-hour minimum bills four. Applying it here rather than in the form
 * means the quote, the invoice and the report cannot disagree.
 */
export function billedHours(
  hoursBooked: number | null,
  minimumHours: number | null,
): number | null {
  if (hoursBooked === null) return null;
  return Math.max(hoursBooked, minimumHours ?? 0);
}

/**
 * Billed days for a contract.
 *
 * The same rule as `billedHours`, for the same reason: a three-day booking on
 * a five-day minimum bills five, and applying that here rather than in the
 * form means the quote, the invoice and the report cannot disagree.
 */
export function billedDays(
  daysBooked: number | null,
  minimumDays: number | null,
): number | null {
  if (daysBooked === null) return null;
  return Math.max(daysBooked, minimumDays ?? 0);
}

/**
 * How many days a contract covers, counting both ends.
 *
 * Monday to Friday is five days, not four — the car is out on Friday. Counted
 * in calendar days in the operator's own timezone rather than in 24-hour
 * blocks, because "five days at £400" is about days on the road, and a
 * booking that starts at 9am and ends at 6pm on the fifth day is still five.
 *
 * The timezone matters twice over: a contract spanning a clocks-change
 * weekend contains a 23- or 25-hour day, and dividing elapsed milliseconds
 * would bill four days for five, or six.
 */
export function contractDays(
  startAt: Date,
  endsAt: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  const days = daysBetweenDates(startAt, endsAt, timeZone);
  // A block that ends before it starts is not a negative contract; it is one
  // day, and the form refuses the ordering separately.
  return Math.max(1, days + 1);
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
