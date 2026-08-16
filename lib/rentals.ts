import type { RentalRateType, RentalStatus } from '@prisma/client';
import { roundPence, sumPence } from './money';

/**
 * Renting the company's cars out.
 *
 * A rental is deliberately not a Job. It has no pickup, no dropoff and no
 * passenger, it spans days rather than minutes, and it earns money with no
 * journey attached. Forcing it into `Job` would put rows with no route into
 * every job report and quietly corrupt the per-job figures this system exists
 * to make trustworthy.
 *
 * It is also the one place money flows *toward* the company from a driver,
 * which is the opposite direction to a payout — so it cannot ride on the
 * payout tables either.
 */

export const RENTAL_REFERENCE_PREFIX = 'RNT';
export const RENTAL_REFERENCE_PAD = 6;

const MINUTES = 60 * 1000;
const HOUR = 60 * MINUTES;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const PERIOD_MS: Record<RentalRateType, number> = {
  HOURLY: HOUR,
  DAILY: DAY,
  WEEKLY: WEEK,
};

export const RATE_TYPE_LABELS: Record<RentalRateType, string> = {
  HOURLY: 'Per hour',
  DAILY: 'Per day',
  WEEKLY: 'Per week',
};

export const RATE_TYPE_UNIT: Record<RentalRateType, string> = {
  HOURLY: 'hour',
  DAILY: 'day',
  WEEKLY: 'week',
};

export const RENTAL_STATUS_LABELS: Record<RentalStatus, string> = {
  BOOKED: 'Booked',
  ACTIVE: 'Out',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
};

/**
 * How many rate periods a hire covers.
 *
 * Rounded **up**, always: an extra hour on a daily hire is a second day.
 * That is what a rental agreement says, and rounding down would hand back
 * revenue on every late return. A hire of zero length still costs one period
 * — the car was taken off the fleet.
 */
export function chargeablePeriods(
  from: Date,
  to: Date,
  rateType: RentalRateType,
): number {
  const elapsed = to.getTime() - from.getTime();
  if (elapsed <= 0) return 1;
  return Math.ceil(elapsed / PERIOD_MS[rateType]);
}

/**
 * The end date the charge is calculated to.
 *
 * The actual return when there is one, even if it is early — the customer
 * pays for what they used, and a car brought back on Tuesday does not bill to
 * Friday. A late return bills to the late date, which is the case the
 * round-up above exists for.
 */
export function chargeableEnd(rental: {
  endAt: Date;
  returnedAt: Date | null;
}): Date {
  return rental.returnedAt ?? rental.endAt;
}

export interface RentalCharge {
  periods: number;
  rentalPence: number;
  damageChargePence: number;
  /** Rental plus damage. What the renter owes before payments. */
  totalPence: number;
}

/**
 * What the hire comes to.
 *
 * Damage is added on top rather than folded into the rate: it is not part of
 * what was agreed, and an invoice that hides it inside the daily rate is one
 * nobody can check.
 */
export function rentalCharge(rental: {
  startAt: Date;
  endAt: Date;
  returnedAt: Date | null;
  rateType: RentalRateType;
  ratePence: number;
  damageChargePence: number;
}): RentalCharge {
  const periods = chargeablePeriods(
    rental.startAt,
    chargeableEnd(rental),
    rental.rateType,
  );
  const rentalPence = roundPence(periods * rental.ratePence);
  const damageChargePence = Math.max(0, rental.damageChargePence);

  return {
    periods,
    rentalPence,
    damageChargePence,
    totalPence: rentalPence + damageChargePence,
  };
}

export interface RentalBalance extends RentalCharge {
  paidPence: number;
  /** Positive means the renter still owes. */
  balancePence: number;
  /** Deposit held and not yet given back. */
  depositHeldPence: number;
  inArrears: boolean;
}

/**
 * What is still owed.
 *
 * The deposit is deliberately *not* netted off. It is the renter's money held
 * against damage, not a payment toward the hire — treating it as one is how a
 * business ends up thinking a rental is settled when it has only been
 * secured. It is reported separately so both numbers are visible.
 */
export function rentalBalance(
  rental: {
    startAt: Date;
    endAt: Date;
    returnedAt: Date | null;
    rateType: RentalRateType;
    ratePence: number;
    damageChargePence: number;
    depositPence: number;
    depositReturnedPence: number;
  },
  payments: Array<{ amountPence: number }>,
): RentalBalance {
  const charge = rentalCharge(rental);
  const paidPence = sumPence(...payments.map((payment) => payment.amountPence));
  const balancePence = charge.totalPence - paidPence;

  return {
    ...charge,
    paidPence,
    balancePence,
    depositHeldPence: Math.max(
      0,
      rental.depositPence - rental.depositReturnedPence,
    ),
    inArrears: balancePence > 0,
  };
}

/**
 * Whether a rental occupies the vehicle across `[from, to]`.
 *
 * A cancelled rental never took the car; a returned one occupied it only up
 * to the actual return, which is why an early return frees the car for the
 * rest of the week rather than blocking it until the planned end.
 */
export function occupiesVehicle(
  rental: {
    startAt: Date;
    endAt: Date;
    returnedAt: Date | null;
    status: RentalStatus;
  },
  from: Date,
  to: Date = from,
): boolean {
  if (rental.status === 'CANCELLED') return false;
  const end = rental.returnedAt ?? rental.endAt;
  return rental.startAt.getTime() <= to.getTime() && from.getTime() <= end.getTime();
}

export type RentalRefusal =
  | { ok: true }
  | { ok: false; message: string; rentalReference?: string };

/**
 * May this vehicle be put on a job at `at`? (spec 2.5.3.10)
 *
 * Refused the same way a lapsed MOT is refused, and for the same reason: the
 * car is not available to send. The difference is that this one is
 * recoverable by talking to the renter, so the message names the rental.
 */
export function vehicleAvailableAt(
  rentals: Array<{
    reference: string;
    startAt: Date;
    endAt: Date;
    returnedAt: Date | null;
    status: RentalStatus;
  }>,
  at: Date,
): RentalRefusal {
  const clash = rentals.find((rental) => occupiesVehicle(rental, at));
  if (!clash) return { ok: true };

  return {
    ok: false,
    message: `That vehicle is out on rental ${clash.reference} at this time`,
    rentalReference: clash.reference,
  };
}

/** Overlapping rentals for the same car — the same question, on write. */
export function findRentalOverlap<
  T extends {
    id?: string;
    reference: string;
    startAt: Date;
    endAt: Date;
    returnedAt: Date | null;
    status: RentalStatus;
  },
>(candidate: { id?: string; startAt: Date; endAt: Date }, existing: T[]): T | null {
  return (
    existing.find((rental) => {
      if (candidate.id && rental.id === candidate.id) return false;
      return occupiesVehicle(rental, candidate.startAt, candidate.endAt);
    }) ?? null
  );
}

/**
 * The default handover checklist.
 *
 * Configurable in settings later; these are the items that decide an argument
 * about who broke what, which is the whole purpose of taking one.
 */
export const DEFAULT_CHECKLIST_ITEMS = [
  'Bodywork — no new dents or scratches',
  'Windscreen and windows — no chips or cracks',
  'Tyres — tread and pressure',
  'Lights and indicators',
  'Interior — clean, no damage or marks',
  'Spare wheel or tyre kit present',
  'Documents and insurance certificate in the car',
  'Warning triangle and hi-vis present',
  'Charging cable present (electric vehicles)',
  'Keys — both sets returned',
] as const;

/** Fuel difference in percentage points, negative when it comes back emptier. */
export function fuelDifferencePct(
  fuelOutPct: number | null,
  fuelInPct: number | null,
): number | null {
  if (fuelOutPct === null || fuelInPct === null) return null;
  return fuelInPct - fuelOutPct;
}

/** Miles driven during the hire, or null when either reading is missing. */
export function mileageDriven(
  mileageOut: number | null,
  mileageIn: number | null,
): number | null {
  if (mileageOut === null || mileageIn === null) return null;
  // A reading that went backwards is a typo, not negative mileage.
  return Math.max(0, mileageIn - mileageOut);
}

/**
 * Who a vehicle went out to.
 *
 * A rental has three possible renters — a driver on the fleet, a company with
 * an account, or somebody with neither — and almost every screen wants the
 * same thing from all three: a name to show. Resolved once here so a list, an
 * invoice line and a hire contract cannot disagree about who had the car.
 */
export interface RenterSource {
  renterType: 'DRIVER' | 'ACCOUNT' | 'EXTERNAL';
  driver?: { name: string; phone?: string | null } | null;
  account?: { name: string; contactPhone?: string | null; billingAddress?: string | null } | null;
  hirerName?: string | null;
  hirerPhone?: string | null;
  hirerAddress?: string | null;
  hirerLicenceNumber?: string | null;
}

export function renterName(rental: RenterSource): string {
  if (rental.renterType === 'ACCOUNT') return rental.account?.name ?? 'Unknown account';
  if (rental.renterType === 'EXTERNAL') return rental.hirerName?.trim() || 'Unnamed hirer';
  return rental.driver?.name ?? 'Unknown driver';
}

/** Name, address, phone and licence, as the contract prints them. */
export function renterDetails(rental: RenterSource): {
  name: string;
  address: string | null;
  phone: string | null;
  licenceNumber: string | null;
} {
  switch (rental.renterType) {
    case 'ACCOUNT':
      return {
        name: rental.account?.name ?? 'Unknown account',
        // A company hire is signed by someone, but the licence belongs to
        // whoever drives it — recorded per hire, not on the account.
        address: rental.account?.billingAddress ?? rental.hirerAddress ?? null,
        phone: rental.account?.contactPhone ?? rental.hirerPhone ?? null,
        licenceNumber: rental.hirerLicenceNumber ?? null,
      };
    case 'EXTERNAL':
      return {
        name: rental.hirerName?.trim() || 'Unnamed hirer',
        address: rental.hirerAddress ?? null,
        phone: rental.hirerPhone ?? null,
        licenceNumber: rental.hirerLicenceNumber ?? null,
      };
    default:
      return {
        name: rental.driver?.name ?? 'Unknown driver',
        address: rental.hirerAddress ?? null,
        phone: rental.driver?.phone ?? rental.hirerPhone ?? null,
        licenceNumber: rental.hirerLicenceNumber ?? null,
      };
  }
}
