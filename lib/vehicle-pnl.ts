import type { VehicleOwnership } from '@prisma/client';
import { marginPct, sumPence } from './money';
import { accrueAll, companyBearsCosts, type StandingCost } from './vehicle-costs';

/**
 * What a car is actually making.
 *
 * Two different questions, depending on who owns it, and the profit view has
 * to answer both without pretending they are the same:
 *
 * - A **company car** earns from jobs and rentals, and the company pays to
 *   run it — finance or lease, insurance, tax, servicing, repairs — plus
 *   whoever drove it. Profit is what is left. This is the number that decides
 *   whether the car is worth keeping.
 * - A **driver-owned car** costs the company nothing to run. Its repairs are
 *   its owner's problem and counting them here would be wrong twice over:
 *   understating that car's margin and overstating company expenditure. What
 *   it earns is the margin between what the client paid and what the driver
 *   was paid.
 *
 * Rental revenue is kept as its own line throughout. A car earning well from
 * hire and badly from jobs is a different business decision from one earning
 * evenly, and a single blended figure hides which is which.
 */

export interface VehicleJobContribution {
  /** Everything the client was charged for the job. */
  revenuePence: number;
  /** What the driver was paid for it. Zero when a shift covered them. */
  driverPayPence: number;
  /** Job expenses the company bore. */
  companyExpensePence: number;
}

export interface VehiclePnlInput {
  ownership: VehicleOwnership;
  jobs: VehicleJobContribution[];
  /** Charge on rentals of this car in the window, damage included. */
  rentalRevenuePence: number;
  /** Pay for shifts worked in this car in the window. */
  shiftPayPence: number;
  /** One-off costs dated inside the window. */
  oneOffCostPence: number;
  /** Standing costs, accrued across the window rather than charged whole. */
  standingCosts: StandingCost[];
  from: Date;
  to: Date;
}

export interface VehiclePnl {
  jobRevenuePence: number;
  rentalRevenuePence: number;
  revenuePence: number;

  driverPayPence: number;
  companyExpensePence: number;
  runningCostPence: number;
  standingCostPence: number;
  costPence: number;

  profitPence: number;
  marginPct: number | null;

  /** False for a driver-owned car, whose running costs are not the company's. */
  costsCounted: boolean;
  /** True when nothing at all happened — reported rather than shown as zero. */
  idle: boolean;
}

export function vehiclePnl(input: VehiclePnlInput): VehiclePnl {
  const jobRevenuePence = sumPence(...input.jobs.map((job) => job.revenuePence));
  const revenuePence = jobRevenuePence + input.rentalRevenuePence;

  const driverPayPence =
    sumPence(...input.jobs.map((job) => job.driverPayPence)) + input.shiftPayPence;
  const companyExpensePence = sumPence(
    ...input.jobs.map((job) => job.companyExpensePence),
  );

  const costsCounted = companyBearsCosts(input.ownership);
  const runningCostPence = costsCounted ? input.oneOffCostPence : 0;
  const standingCostPence = costsCounted
    ? accrueAll(input.standingCosts, input.from, input.to)
    : 0;

  const costPence =
    driverPayPence + companyExpensePence + runningCostPence + standingCostPence;
  const profitPence = revenuePence - costPence;

  return {
    jobRevenuePence,
    rentalRevenuePence: input.rentalRevenuePence,
    revenuePence,
    driverPayPence,
    companyExpensePence,
    runningCostPence,
    standingCostPence,
    costPence,
    profitPence,
    // Consistent with every other margin in the system: no revenue means no
    // margin, not a margin of zero.
    marginPct: marginPct(revenuePence, profitPence),
    costsCounted,
    // A car that did nothing is idle, not loss-making — unless the company is
    // still paying to keep it, which is exactly the case worth seeing.
    idle:
      input.jobs.length === 0 &&
      input.rentalRevenuePence === 0 &&
      input.shiftPayPence === 0 &&
      runningCostPence === 0 &&
      standingCostPence === 0,
  };
}

/** The last twelve months, the default window. */
export function defaultPnlWindow(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now);
  from.setMonth(from.getMonth() - 12);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The window a page was asked for, falling back to the last twelve months.
 *
 * Both ends are widened to cover their whole day, so a window typed as a
 * single date includes the jobs done on it rather than only those at
 * midnight.
 */
export function parsePnlWindow(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const fallback = defaultPnlWindow(now);

  const start =
    from && DATE_ONLY.test(from) ? new Date(`${from}T00:00:00.000Z`) : fallback.from;
  const end =
    to && DATE_ONLY.test(to) ? new Date(`${to}T23:59:59.999Z`) : fallback.to;

  // A backwards window would silently report zero of everything, which reads
  // as an idle car rather than as a typo.
  if (end.getTime() < start.getTime()) return { from: end, to: start };
  return { from: start, to: end };
}

/** The window as the date inputs want it. */
export function windowToInputs(window: { from: Date; to: Date }) {
  return {
    from: window.from.toISOString().slice(0, 10),
    to: window.to.toISOString().slice(0, 10),
  };
}

/**
 * Rank vehicles worst-first, so the car losing money is the one you see.
 *
 * Idle vehicles sort last whatever their profit: a car that did nothing is
 * not the fleet's problem, and letting a string of zeroes head the list
 * buries the one that actually lost money.
 */
export function rankByProfit<T extends { pnl: VehiclePnl }>(vehicles: T[]): T[] {
  return [...vehicles].sort((a, b) => {
    if (a.pnl.idle !== b.pnl.idle) return a.pnl.idle ? 1 : -1;
    return a.pnl.profitPence - b.pnl.profitPence;
  });
}
