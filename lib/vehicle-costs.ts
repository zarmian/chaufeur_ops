import type { VehicleCostKind, VehicleOwnership } from '@prisma/client';
import { roundPence, sumPence } from './money';

/**
 * Vehicle running costs, and how a recurring one lands in a given month.
 *
 * The pro-rata accrual is the whole reason this module exists. A £1,200
 * annual insurance premium recorded as a single April payment makes April
 * look like a disaster and every other month look free, which tells the
 * operator nothing about whether the car is worth keeping. Spread across the
 * period it covers, a month's profit is comparable with the month before it
 * and with the car parked next to it.
 */

const DAY = 24 * 60 * 60 * 1000;

export const COST_KIND_LABELS: Record<VehicleCostKind, string> = {
  SERVICE: 'Service',
  REPAIR: 'Repair',
  MOT_TEST: 'MOT test',
  TYRES: 'Tyres',
  BODYWORK: 'Bodywork',
  CLEANING: 'Cleaning',
  INSURANCE: 'Insurance',
  ROAD_TAX: 'Road tax',
  FINANCE: 'Finance payment',
  LEASE: 'Lease payment',
  BREAKDOWN_COVER: 'Breakdown cover',
  PARKING_PERMIT: 'Parking permit',
  OTHER: 'Other',
};

/** The kinds normally set up as standing costs rather than entered each time. */
export const STANDING_COST_KINDS: VehicleCostKind[] = [
  'INSURANCE',
  'ROAD_TAX',
  'FINANCE',
  'LEASE',
  'BREAKDOWN_COVER',
  'PARKING_PERMIT',
];

export const OWNERSHIP_LABELS: Record<VehicleOwnership, string> = {
  OWNED: 'Company owned',
  FINANCED: 'Company, on finance',
  LEASED: 'Company, leased',
  DRIVER_OWNED: "Driver's own car",
};

/**
 * Whether the company bears this vehicle's running costs.
 *
 * A driver-owned car's repairs are its owner's. Recording them against the
 * company would both understate that car's margin and overstate what the
 * company spends — two wrong numbers from one mistake.
 */
export function companyBearsCosts(ownership: VehicleOwnership): boolean {
  return ownership !== 'DRIVER_OWNED';
}

export interface StandingCost {
  amountPence: number;
  /** The amount is charged once per this many months. */
  periodMonths: number;
  startsOn: Date;
  /** Null means still running. */
  endsOn: Date | null;
}

/**
 * How much of a standing cost falls inside `[from, to]`.
 *
 * Accrued by day rather than by whole periods, so a window that starts
 * mid-month gets the right fraction. The alternative — charging a whole
 * period whenever one overlaps — would double-count a cost that straddles two
 * windows, and no two adjacent months would add up to the year.
 *
 * Both ends of the window are inclusive.
 */
export function accruedStandingCost(
  cost: StandingCost,
  from: Date,
  to: Date,
): number {
  if (cost.periodMonths <= 0 || cost.amountPence === 0) return 0;

  const start = Math.max(cost.startsOn.getTime(), from.getTime());
  const end = Math.min(
    (cost.endsOn ?? new Date(8640000000000000)).getTime(),
    to.getTime(),
  );
  if (end < start) return 0;

  // Inclusive of both days, so a single-day window accrues one day.
  const days = Math.floor((end - start) / DAY) + 1;
  // 365.25/12 — the average month, so a 31-day January and a 28-day February
  // each accrue about a month's worth rather than 11% more or less.
  const daysPerPeriod = cost.periodMonths * 30.4375;

  return roundPence((cost.amountPence / daysPerPeriod) * days);
}

/** Every standing cost accrued across the window, added up. */
export function accrueAll(
  costs: StandingCost[],
  from: Date,
  to: Date,
): number {
  return sumPence(...costs.map((cost) => accruedStandingCost(cost, from, to)));
}

export interface ServiceStatus {
  due: boolean;
  /** Days until the service is due; negative when overdue. Null if not dated. */
  daysRemaining: number | null;
  /** Miles until the service is due; negative when overdue. Null if unknown. */
  milesRemaining: number | null;
  reason: string | null;
}

export const DEFAULT_SERVICE_MONTHS = 12;
export const DEFAULT_SERVICE_MILES = 12_000;

/**
 * Whether a service is due, by date or by mileage, whichever comes first.
 *
 * Deliberately *not* part of the compliance check. A lapsed MOT is illegal
 * and stops the car; an overdue service is a maintenance decision the
 * operator makes with the facts in front of them. Conflating the two would
 * mean either blocking work that is legal, or quietly downgrading the checks
 * that are not negotiable.
 */
export function serviceStatus(
  vehicle: {
    lastServicedOn: Date | null;
    lastServiceMiles: number | null;
    currentOdometer: number | null;
    serviceEveryMonths: number | null;
    serviceEveryMiles: number | null;
  },
  at: Date = new Date(),
): ServiceStatus {
  const everyMonths = vehicle.serviceEveryMonths ?? DEFAULT_SERVICE_MONTHS;
  const everyMiles = vehicle.serviceEveryMiles ?? DEFAULT_SERVICE_MILES;

  let daysRemaining: number | null = null;
  if (vehicle.lastServicedOn) {
    const dueOn = new Date(vehicle.lastServicedOn);
    dueOn.setMonth(dueOn.getMonth() + everyMonths);
    daysRemaining = Math.floor((dueOn.getTime() - at.getTime()) / DAY);
  }

  let milesRemaining: number | null = null;
  if (vehicle.lastServiceMiles !== null && vehicle.currentOdometer !== null) {
    milesRemaining =
      vehicle.lastServiceMiles + everyMiles - vehicle.currentOdometer;
  }

  const dueByDate = daysRemaining !== null && daysRemaining <= 0;
  const dueByMiles = milesRemaining !== null && milesRemaining <= 0;

  // Never serviced and no reading either: unknown, not due. Claiming a
  // service is due on a car nobody has recorded anything about is noise.
  if (daysRemaining === null && milesRemaining === null) {
    return { due: false, daysRemaining: null, milesRemaining: null, reason: null };
  }

  return {
    due: dueByDate || dueByMiles,
    daysRemaining,
    milesRemaining,
    reason: dueByDate
      ? `Service overdue by ${Math.abs(daysRemaining ?? 0)} days`
      : dueByMiles
        ? `Service overdue by ${Math.abs(milesRemaining ?? 0)} miles`
        : null,
  };
}
