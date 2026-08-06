import type { JobType, VehicleClass } from '@prisma/client';
import { roundPence } from '../money';

/**
 * Choosing a rate card rule, and working out what it says the job costs.
 *
 * Pure — no database, no clock beyond what is passed in — so the matching
 * order can be tested exhaustively. The order is the part worth being sure
 * about: an operator sees one price and has no way to tell which of eleven
 * overlapping rules produced it, so "most specific wins" has to be true
 * rather than roughly true.
 *
 * Specificity, in order:
 *
 * 1. **Both zones named.** A Heathrow-to-Central-London rule is about that
 *    journey and nothing else.
 * 2. **One zone named.** Anything from Heathrow, or anything into Gatwick.
 * 3. **Neither.** The catch-all for the job type.
 *
 * Vehicle class refines within each of those rather than across them: a rule
 * for executive cars anywhere is a weaker claim about a Heathrow run than a
 * Heathrow rule that says nothing about the car. `priority` breaks whatever
 * is left, and the rule id breaks that, so the same inputs always produce the
 * same price.
 */

export interface RateRule {
  id: string;
  jobType: JobType;
  vehicleClass: VehicleClass | null;
  fromZoneId: string | null;
  toZoneId: string | null;

  baseFarePence: number;
  perHourPence: number;
  minimumHours: number | null;
  freeWaitMinutes: number;
  waitPerMinutePence: number;

  driverBasePence: number;
  driverPerHourPence: number;
  /** Percentage of the client fare. Never set alongside a fixed driver rate. */
  driverPctOfFare: number | null;

  priority: number;
}

export interface RateQuery {
  jobType: JobType;
  vehicleClass?: VehicleClass | null;
  fromZoneId?: string | null;
  toZoneId?: string | null;
  /** For `AS_DIRECTED`, the hours being booked. */
  hours?: number | null;
  /** Billable waiting beyond the free allowance, in minutes. */
  waitMinutes?: number | null;
}

/** Zones weigh more than the car, so the journey decides before the vehicle. */
const ZONE_WEIGHT = 4;
const CLASS_WEIGHT = 1;

/**
 * Whether a rule could apply at all.
 *
 * A rule naming a zone applies only to that zone. A rule naming none applies
 * anywhere — that is what makes it the catch-all rather than a rule that
 * matches nothing.
 */
export function ruleApplies(rule: RateRule, query: RateQuery): boolean {
  if (rule.jobType !== query.jobType) return false;

  if (rule.vehicleClass !== null && rule.vehicleClass !== query.vehicleClass) {
    return false;
  }
  if (rule.fromZoneId !== null && rule.fromZoneId !== query.fromZoneId) {
    return false;
  }
  if (rule.toZoneId !== null && rule.toZoneId !== query.toZoneId) {
    return false;
  }

  return true;
}

/** How specific a rule's claim is. Higher is more specific. */
export function specificity(rule: RateRule): number {
  return (
    (rule.fromZoneId !== null ? ZONE_WEIGHT : 0) +
    (rule.toZoneId !== null ? ZONE_WEIGHT : 0) +
    (rule.vehicleClass !== null ? CLASS_WEIGHT : 0)
  );
}

/**
 * The rule that should price this job, or null.
 *
 * Null is a first-class answer. Most bookings will never match a rule, and
 * the booking form treats no suggestion as normal — the phone call is
 * happening either way.
 */
export function resolveRule(
  rules: RateRule[],
  query: RateQuery,
): RateRule | null {
  const applicable = rules.filter((rule) => ruleApplies(rule, query));
  if (applicable.length === 0) return null;

  const sorted = [...applicable].sort((a, b) => {
    const bySpecificity = specificity(b) - specificity(a);
    if (bySpecificity !== 0) return bySpecificity;

    const byPriority = b.priority - a.priority;
    if (byPriority !== 0) return byPriority;

    // Last resort, so two equally-good rules do not produce different prices
    // on different days.
    return a.id.localeCompare(b.id);
  });

  return sorted[0]!;
}

export interface PricedRate {
  ruleId: string;
  clientPricePence: number;
  /** Null when the rule says nothing about driver pay. */
  driverPricePence: number | null;
  freeWaitMinutes: number;
  /** In the operator's words, so a surprising number can be understood. */
  explanation: string;
}

/**
 * What a rule says a job costs.
 *
 * Hourly work multiplies out and is floored at the minimum; fixed-fare work
 * is the base fare. Waiting beyond the free allowance is added either way,
 * because a delayed flight costs the same whichever kind of job it was.
 *
 * Rounding happens once, at the end of each side, so the client price and the
 * driver price never disagree with themselves by a penny.
 */
export function priceFromRule(rule: RateRule, query: RateQuery): PricedRate {
  const parts: string[] = [];

  let clientPence = 0;

  if (rule.perHourPence > 0) {
    const requested = query.hours ?? 0;
    const minimum = rule.minimumHours ?? 0;
    const billedHours = Math.max(requested, minimum);

    clientPence += roundPence(rule.perHourPence * billedHours);

    parts.push(
      billedHours > requested
        ? `${billedHours} hours at the minimum (${requested} booked)`
        : `${billedHours} hours`,
    );
  }

  if (rule.baseFarePence > 0) {
    clientPence += rule.baseFarePence;
    parts.push(rule.perHourPence > 0 ? 'plus the base fare' : 'base fare');
  }

  const waitMinutes = query.waitMinutes ?? 0;
  const billableWait = Math.max(0, waitMinutes - rule.freeWaitMinutes);
  if (billableWait > 0 && rule.waitPerMinutePence > 0) {
    clientPence += roundPence(rule.waitPerMinutePence * billableWait);
    parts.push(
      `${billableWait} min waiting beyond the ${rule.freeWaitMinutes} free`,
    );
  }

  clientPence = roundPence(clientPence);

  return {
    ruleId: rule.id,
    clientPricePence: clientPence,
    driverPricePence: driverPayFromRule(rule, query, clientPence),
    freeWaitMinutes: rule.freeWaitMinutes,
    explanation: parts.length > 0 ? parts.join(', ') : 'no charge on this rule',
  };
}

/**
 * What the rule says the driver gets.
 *
 * A percentage of the fare **or** fixed amounts, never both — a rule setting
 * both is rejected at validation, and this treats the percentage as
 * authoritative if one ever slips through, because a percentage plus a fixed
 * fee would silently overpay.
 */
export function driverPayFromRule(
  rule: RateRule,
  query: RateQuery,
  clientPence: number,
): number | null {
  if (rule.driverPctOfFare !== null) {
    return roundPence((clientPence * rule.driverPctOfFare) / 100);
  }

  const hasFixed = rule.driverBasePence > 0 || rule.driverPerHourPence > 0;
  if (!hasFixed) return null;

  const requested = query.hours ?? 0;
  const minimum = rule.minimumHours ?? 0;
  const billedHours = Math.max(requested, minimum);

  return roundPence(
    rule.driverBasePence + rule.driverPerHourPence * billedHours,
  );
}

/**
 * Whether a rule is internally consistent.
 *
 * Checked here as well as in the form schema, because a rule can also arrive
 * from a seed or an import — and a rule paying a driver twice is the kind of
 * mistake that is only noticed at the end of the month.
 */
export function ruleProblems(rule: Partial<RateRule>): string[] {
  const problems: string[] = [];

  const hasPct = rule.driverPctOfFare !== null && rule.driverPctOfFare !== undefined;
  const hasFixed =
    (rule.driverBasePence ?? 0) > 0 || (rule.driverPerHourPence ?? 0) > 0;

  if (hasPct && hasFixed) {
    problems.push(
      'A rule pays the driver a percentage of the fare or a fixed amount, never both — together they would overpay on every job.',
    );
  }

  if (hasPct && (rule.driverPctOfFare! < 0 || rule.driverPctOfFare! > 100)) {
    problems.push('The driver percentage has to be between 0 and 100.');
  }

  if (
    (rule.baseFarePence ?? 0) === 0 &&
    (rule.perHourPence ?? 0) === 0
  ) {
    problems.push(
      'A rule with no base fare and no hourly rate prices every matching job at nothing.',
    );
  }

  if ((rule.minimumHours ?? 0) > 0 && (rule.perHourPence ?? 0) === 0) {
    problems.push(
      'A minimum number of hours means nothing without an hourly rate.',
    );
  }

  return problems;
}
