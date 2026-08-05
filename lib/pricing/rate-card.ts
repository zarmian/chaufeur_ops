import type { JobType, VehicleClass } from '@prisma/client';

/**
 * Rate card resolution — the suggested price for a booking.
 *
 * Phase 2 needs the *shape* of this, not the arithmetic: the create form asks
 * for a suggestion when the operator picks a client and account, and shows
 * nothing when there isn't one. Phase 4 fills in the resolution once the
 * business supplies real commercial rates (see the open questions in
 * `README.md` — the rates are not known yet, and inventing them would put
 * plausible-looking wrong numbers in front of an operator).
 *
 * Returning `null` is a first-class answer, not a placeholder failure. Most
 * bookings will never match a rule, and the form must treat "no suggestion"
 * as normal rather than as an error. Building against that from the start is
 * why this stub exists rather than the call being added later.
 *
 * What must NOT happen when Phase 4 lands: a suggestion silently becoming the
 * saved price. The suggestion pre-fills a field the operator can overwrite,
 * and what they leave in the field is what gets stored. The price is a
 * commercial agreement, not a calculation.
 */

export interface RateQuery {
  jobType: JobType;
  vehicleClass?: VehicleClass | null;
  accountId?: string | null;
  clientId?: string | null;
  /** Resolved zones, once Phase 4 maps pickup and dropoff text to zones. */
  fromZoneId?: string | null;
  toZoneId?: string | null;
  /** For `AS_DIRECTED`, the hours being booked. */
  hours?: number | null;
  scheduledAt: Date;
}

export interface RateSuggestion {
  /** The rule this came from, stored on the job for later reconciliation. */
  rateCardRuleId: string;
  clientPricePence: number;
  driverPricePence: number | null;
  /** Shown next to the field so the operator knows why it says what it says. */
  explanation: string;
}

/**
 * The suggested prices for a booking, or `null` when no rule matches.
 *
 * Phase 4 replaces the body. The signature is the contract: async, nullable,
 * and never throwing — a pricing lookup that fails must not stop a booking
 * being taken, because the phone call is still happening either way.
 */
export async function suggestPrice(
  _query: RateQuery,
): Promise<RateSuggestion | null> {
  return null;
}

/**
 * Whether this job type is priced by the hour.
 *
 * `AS_DIRECTED` is hourly with a minimum-hours rule; `TRANSFER` and
 * `AIRPORT_TRANSFER` are fixed-fare. The form uses this to decide whether to
 * ask for hours, so it is needed in Phase 2 even though the rates are not.
 */
export function isHourlyJobType(jobType: JobType): boolean {
  return jobType === 'AS_DIRECTED';
}
