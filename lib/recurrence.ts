import { getPartsInZone, partsToUTC } from './dates';

/**
 * Expanding a recurring booking into its occurrences — spec 6.3.3.
 *
 * Pure, and separate from the database on purpose: the arithmetic here is the
 * part that is easy to get wrong and cheap to test exhaustively.
 *
 * **The rule is in wall-clock terms, not in elapsed time.** A daily 09:00
 * airport run is at 09:00 every day, and across the March transition that is
 * twenty-three hours after the previous one, not twenty-four. Generating
 * occurrences by adding 86,400,000ms to a UTC instant produces a series that
 * silently slips to 10:00 for half the year — which for an airport transfer
 * means the passenger misses the flight. So every occurrence is built as a
 * civil date plus a fixed time of day, and only converted to UTC at the end.
 *
 * Occurrences that do not exist are dropped rather than moved. The 31st of
 * the month in February is not the 28th: an operator who wanted the last day
 * of the month can say so, and a system that quietly re-dates a booking is
 * worse than one that skips it visibly.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface RecurrenceRule {
  frequency: Frequency;
  /** Every N days, weeks or months. 1 is every one. */
  interval: number;
  /**
   * `WEEKLY` only: 0 = Sunday … 6 = Saturday. Empty means "the same weekday
   * as the first occurrence", which is what somebody means by "weekly".
   */
  weekdays?: number[];
  /** The first occurrence. Its wall clock in `timeZone` fixes the time of day. */
  startsAt: Date;
  /** Stop after this many occurrences, the first one included. */
  count?: number | null;
  /** Or stop at the end of this day, in `timeZone`. */
  until?: Date | null;
}

/**
 * A hard ceiling, whatever the rule says.
 *
 * Not a business rule — a guard against a typo. "Daily until 2099" is a
 * slip, and the cost of honouring it is 27,000 jobs, an unusable job list and
 * an audit log nobody can read. A year of daily work is past anything anyone
 * books in advance.
 */
export const MAX_OCCURRENCES = 366;

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Calendar arithmetic on civil dates.
 *
 * `Date.UTC` is used purely as a calendar here — never as an instant. Doing
 * the day and month stepping in UTC means it cannot be perturbed by the very
 * transitions this module exists to handle.
 */
function addDays(date: CivilDate, days: number): CivilDate {
  const stepped = new Date(Date.UTC(date.year, date.month - 1, date.day));
  stepped.setUTCDate(stepped.getUTCDate() + days);
  return {
    year: stepped.getUTCFullYear(),
    month: stepped.getUTCMonth() + 1,
    day: stepped.getUTCDate(),
  };
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function compare(a: CivilDate, b: CivilDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/** Whether the calendar actually has this date — 31 February does not. */
function exists(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() + 1 === month && probe.getUTCDate() === day;
}

export function describeRule(rule: RecurrenceRule, timeZone: string): string {
  const every = rule.interval === 1 ? '' : ` ${ordinal(rule.interval)}`;

  if (rule.frequency === 'DAILY') return `Every${every} day`;
  if (rule.frequency === 'MONTHLY') {
    const { day } = getPartsInZone(rule.startsAt, timeZone);
    return `Every${every} month on the ${ordinal(day)}`;
  }

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const days = normaliseWeekdays(rule, timeZone);
  return `Every${every} week on ${days.map((d) => names[d]).join(', ')}`;
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
}

function normaliseWeekdays(rule: RecurrenceRule, timeZone: string): number[] {
  const chosen = (rule.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (chosen.length > 0) return [...new Set(chosen)].sort((a, b) => a - b);

  const parts = getPartsInZone(rule.startsAt, timeZone);
  return [weekdayOf({ year: parts.year, month: parts.month, day: parts.day })];
}

/**
 * The occurrences of `rule`, as UTC instants, first one included.
 *
 * Throws rather than guessing when the rule cannot terminate. A recurrence
 * with neither an end date nor a count is not a long series, it is an
 * unanswered question, and defaulting it would put jobs on the board that
 * nobody chose.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  timeZone: string,
): Date[] {
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new RecurrenceError('Interval must be a whole number of at least 1');
  }
  if ((rule.count ?? null) === null && (rule.until ?? null) === null) {
    throw new RecurrenceError('A recurrence needs either an end date or a number of occurrences');
  }
  if (rule.count != null && (!Number.isInteger(rule.count) || rule.count < 1)) {
    throw new RecurrenceError('Occurrence count must be a whole number of at least 1');
  }

  const limit = Math.min(rule.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);

  const start = getPartsInZone(rule.startsAt, timeZone);
  const timeOfDay = { hour: start.hour, minute: start.minute, second: 0 };
  const from: CivilDate = { year: start.year, month: start.month, day: start.day };

  // The end date is compared as a civil date in the same zone, so "until the
  // 30th" includes the 30th whatever time of day the series runs at.
  const untilParts = rule.until ? getPartsInZone(rule.until, timeZone) : null;
  const until: CivilDate | null = untilParts
    ? { year: untilParts.year, month: untilParts.month, day: untilParts.day }
    : null;

  if (until && compare(until, from) < 0) {
    throw new RecurrenceError('The end date is before the first occurrence');
  }

  const dates =
    rule.frequency === 'DAILY'
      ? daily(from, rule.interval, limit, until)
      : rule.frequency === 'WEEKLY'
        ? weekly(from, rule.interval, normaliseWeekdays(rule, timeZone), limit, until)
        : monthly(from, rule.interval, limit, until);

  return dates.map((date) =>
    partsToUTC(
      {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: timeOfDay.hour,
        minute: timeOfDay.minute,
        second: 0,
      },
      timeZone,
    ),
  );
}

function daily(
  from: CivilDate,
  interval: number,
  limit: number,
  until: CivilDate | null,
): CivilDate[] {
  const out: CivilDate[] = [];
  let cursor = from;

  while (out.length < limit) {
    if (until && compare(cursor, until) > 0) break;
    out.push(cursor);
    cursor = addDays(cursor, interval);
  }
  return out;
}

/**
 * Weekly, on chosen days.
 *
 * Anchored to the Sunday of the first occurrence's week rather than to the
 * first occurrence itself, so "every other week on Monday and Thursday"
 * means the same pair of days each fortnight — not a pattern that drifts
 * depending on which of the two the operator happened to book first.
 */
function weekly(
  from: CivilDate,
  interval: number,
  weekdays: number[],
  limit: number,
  until: CivilDate | null,
): CivilDate[] {
  const out: CivilDate[] = [];
  let weekStart = addDays(from, -weekdayOf(from));

  // Bounded by the occurrence ceiling however sparse the pattern is: seven
  // days a week at most, so this cannot spin.
  for (let week = 0; week < MAX_OCCURRENCES && out.length < limit; week += 1) {
    for (const weekday of weekdays) {
      const candidate = addDays(weekStart, weekday);

      // The first partial week may contain days before the start.
      if (compare(candidate, from) < 0) continue;
      if (until && compare(candidate, until) > 0) return out;
      if (out.length >= limit) return out;

      out.push(candidate);
    }
    weekStart = addDays(weekStart, 7 * interval);
  }
  return out;
}

/**
 * Monthly, on the same day of the month.
 *
 * A month without that day is skipped, not clamped. Moving the 31st to the
 * 28th would put a car outside a hotel on a day nobody chose, and the
 * operator who wanted month-end can book it.
 */
function monthly(
  from: CivilDate,
  interval: number,
  limit: number,
  until: CivilDate | null,
): CivilDate[] {
  const out: CivilDate[] = [];
  const day = from.day;

  // Stepping months, not occurrences: a series on the 31st produces fewer
  // jobs than months elapsed, so the loop is bounded by months examined.
  for (let step = 0; step < MAX_OCCURRENCES * interval && out.length < limit; step += interval) {
    const month0 = from.month - 1 + step;
    const year = from.year + Math.floor(month0 / 12);
    const month = (month0 % 12) + 1;

    if (!exists(year, month, day)) continue;

    const candidate = { year, month, day };
    if (until && compare(candidate, until) > 0) break;
    out.push(candidate);
  }
  return out;
}

/**
 * The obvious return time — spec 6.3.1.
 *
 * A suggestion, not a rule. Three hours after the outbound covers a typical
 * meeting or a short-haul arrival, and it is a field the operator will
 * change; what matters is that the form opens with something plausible in it
 * rather than empty.
 */
export const RETURN_GAP_HOURS = 3;

export function suggestReturnAt(outboundAt: Date, estimatedMinutes?: number | null): Date {
  const journey = estimatedMinutes && estimatedMinutes > 0 ? estimatedMinutes : 0;
  return new Date(
    outboundAt.getTime() + RETURN_GAP_HOURS * 3_600_000 + journey * 60_000,
  );
}
