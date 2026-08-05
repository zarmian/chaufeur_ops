import type { EngagementKind } from '@prisma/client';

/**
 * Which terms a driver was working under at a given moment.
 *
 * Not a property of the person. The same driver can be an owner-driver one
 * week and hired the next, so this is resolved against a *time* — and against
 * the job's scheduled time, never against "now". Re-opening a job worked last
 * March has to show the terms it was actually worked under; resolving against
 * the present would silently re-price history the moment someone's
 * arrangement changed.
 *
 * A driver with no engagement records behaves exactly as in Phase 2: an
 * owner-driver, paid a fee per job, bearing their own running costs. That
 * default is what makes this additive rather than a migration.
 */

export const DEFAULT_ENGAGEMENT: EngagementKind = 'OWNER_DRIVER';

export interface EngagementPeriod {
  id: string;
  kind: EngagementKind;
  effectiveFrom: Date;
  /** Null means still in force. */
  effectiveTo: Date | null;
  hourlyRatePence: number | null;
  dayRatePence: number | null;
  overtimeAfterMin: number | null;
}

/**
 * Whether `at` falls inside the period.
 *
 * Both ends are inclusive by date. `effectiveTo` is a date column, so a
 * period ending on the 4th covers every moment of the 4th — an engagement
 * that ended "on Friday" includes Friday's late job.
 */
export function coversMoment(period: EngagementPeriod, at: Date): boolean {
  if (at.getTime() < startOfDay(period.effectiveFrom).getTime()) return false;
  if (period.effectiveTo === null) return true;
  return at.getTime() <= endOfDay(period.effectiveTo).getTime();
}

/**
 * The engagement in force at `at`, or null.
 *
 * Periods must not overlap — `findOverlap` enforces that on write — so the
 * first match is the only match. The latest start wins if data ever slips
 * through, because the more recent arrangement is the more likely intent.
 */
export function engagementAt(
  periods: EngagementPeriod[],
  at: Date,
): EngagementPeriod | null {
  const matching = periods.filter((period) => coversMoment(period, at));
  if (matching.length === 0) return null;
  return matching.reduce((latest, period) =>
    period.effectiveFrom.getTime() > latest.effectiveFrom.getTime() ? period : latest,
  );
}

export interface ResolvedEngagement {
  kind: EngagementKind;
  hourlyRatePence: number | null;
  dayRatePence: number | null;
  overtimeAfterMin: number | null;
  /** How this was arrived at, so the UI can say so rather than just asserting. */
  source: 'job-override' | 'engagement' | 'default';
  engagementId: string | null;
}

/**
 * Resolution order, per spec 2.5.1.5: the job's own override, then the
 * engagement covering the job's scheduled time, then the default.
 *
 * The override exists for the case where someone covers a single run on
 * different terms — common enough that forcing a whole dated engagement for
 * one job would just mean nobody records it.
 */
export function resolveEngagement(
  job: { engagementKind: EngagementKind | null; scheduledAt: Date },
  periods: EngagementPeriod[],
): ResolvedEngagement {
  if (job.engagementKind) {
    // An override says what kind, not at what rate — the rate still comes
    // from the arrangement in force, if there is one.
    const period = engagementAt(periods, job.scheduledAt);
    const rateSource = period && period.kind === job.engagementKind ? period : null;
    return {
      kind: job.engagementKind,
      hourlyRatePence: rateSource?.hourlyRatePence ?? null,
      dayRatePence: rateSource?.dayRatePence ?? null,
      overtimeAfterMin: rateSource?.overtimeAfterMin ?? null,
      source: 'job-override',
      engagementId: rateSource?.id ?? null,
    };
  }

  const period = engagementAt(periods, job.scheduledAt);
  if (period) {
    return {
      kind: period.kind,
      hourlyRatePence: period.hourlyRatePence,
      dayRatePence: period.dayRatePence,
      overtimeAfterMin: period.overtimeAfterMin,
      source: 'engagement',
      engagementId: period.id,
    };
  }

  return {
    kind: DEFAULT_ENGAGEMENT,
    hourlyRatePence: null,
    dayRatePence: null,
    overtimeAfterMin: null,
    source: 'default',
    engagementId: null,
  };
}

/**
 * An existing period that clashes with `candidate`, or null.
 *
 * Overlapping engagements would make "what were they on that day" ambiguous,
 * and the answer decides what the driver is paid. Refusing the write is the
 * only honest option — silently picking one would be a guess about money.
 */
export function findOverlap(
  candidate: { effectiveFrom: Date; effectiveTo: Date | null; id?: string },
  existing: EngagementPeriod[],
): EngagementPeriod | null {
  const from = startOfDay(candidate.effectiveFrom).getTime();
  const to = candidate.effectiveTo
    ? endOfDay(candidate.effectiveTo).getTime()
    : Number.POSITIVE_INFINITY;

  return (
    existing.find((period) => {
      if (candidate.id && period.id === candidate.id) return false;
      const otherFrom = startOfDay(period.effectiveFrom).getTime();
      const otherTo = period.effectiveTo
        ? endOfDay(period.effectiveTo).getTime()
        : Number.POSITIVE_INFINITY;
      return from <= otherTo && otherFrom <= to;
    }) ?? null
  );
}

/**
 * Who bears an expense by default, given the engagement.
 *
 * Under `HIRED` the company owns the car and the running costs with it;
 * under `OWNER_DRIVER` the driver does. Always editable — this is the
 * starting point, not a rule.
 */
export function defaultExpenseBearer(
  kind: EngagementKind,
  expenseKind: string,
): 'CLIENT' | 'COMPANY' | 'DRIVER' {
  // Charges incurred on the client's behalf are recharged whoever is driving:
  // the congestion charge was for their journey.
  if (['TOLL', 'CONGESTION_CHARGE', 'ULEZ', 'PARKING', 'WAITING'].includes(expenseKind)) {
    return 'CLIENT';
  }
  return kind === 'HIRED' ? 'COMPANY' : 'DRIVER';
}

export const ENGAGEMENT_LABELS: Record<EngagementKind, string> = {
  OWNER_DRIVER: 'Owner-driver',
  HIRED: 'Hired (paid hourly)',
};

export const ENGAGEMENT_DESCRIPTIONS: Record<EngagementKind, string> = {
  OWNER_DRIVER:
    'Drives their own car, paid a fee per job, bears their own running costs.',
  HIRED:
    'Drives a company car, paid by the hour for a shift. The company bears fuel and running costs.',
};

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(23, 59, 59, 999);
  return copy;
}
