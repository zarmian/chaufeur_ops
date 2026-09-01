import {
  endOfZonedDay,
  getPartsInZone,
  partsToUTC,
  startOfZonedDay,
} from './dates';

/**
 * Where a payout week starts and stops.
 *
 * Payouts run Monday to Sunday. That boundary was written twice — once in the
 * generate-a-payout screen and, when drivers were given a way to see their own
 * earnings, nearly a second time. Two copies of a period boundary is how a
 * driver reads one number in Telegram and gets a different one on the
 * statement, so it lives here and both callers ask for it.
 *
 * **The week turns at local midnight, not UTC midnight.** The screen used to
 * compute the boundary in UTC, which is the same thing for five months of the
 * year and an hour out for the other seven: under British Summer Time, local
 * Monday 00:30 is 23:30 UTC on the Sunday, so an early-hours airport run at
 * the start of the week fell into the week before. It paid out — a week
 * early, on the statement covering the days either side of it — which is
 * exactly the kind of discrepancy nobody reports and everybody notices.
 *
 * Both ends are inclusive, because `draftFor` and `driversOwedIn` filter with
 * `lte` and the stored `periodEnd` is the last instant of the period rather
 * than the first of the next one. That is the opposite convention to
 * `endOfZonedDay`, which is exclusive; the millisecond subtracted below is
 * the whole difference between them.
 */

export interface PayoutWeek {
  /** Local Monday, 00:00:00.000, as a UTC instant. Inclusive. */
  from: Date;
  /** Local Sunday, 23:59:59.999, as a UTC instant. Inclusive. */
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday-to-Sunday week the instant falls in. */
export function payoutWeekOf(instant: Date, timeZone?: string): PayoutWeek {
  const local = getPartsInZone(instant, timeZone);

  /*
   * Weekday from the calendar date alone.
   *
   * Not `startOfZonedDay(instant).getUTCDay()`: that instant is local
   * midnight expressed in UTC, which in summer is 23:00 on the *previous*
   * UTC day — so the weekday would be one out for exactly the jobs this
   * function exists to place correctly.
   */
  const midnightUTC = Date.UTC(local.year, local.month - 1, local.day);
  const weekday = new Date(midnightUTC).getUTCDay();
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;

  // Arithmetic on midnight-UTC values, where a day is always 86,400,000ms.
  const monday = new Date(midnightUTC - sinceMonday * DAY_MS);
  const sunday = new Date(midnightUTC + (6 - sinceMonday) * DAY_MS);

  const from = localMidnight(monday, timeZone);
  const to = new Date(
    endOfZonedDay(localMidnight(sunday, timeZone), timeZone).getTime() - 1,
  );

  return { from, to };
}

/** The week in progress — what a driver has earned so far. */
export function currentPayoutWeek(
  now = new Date(),
  timeZone?: string,
): PayoutWeek {
  return payoutWeekOf(now, timeZone);
}

/**
 * The week that just ended.
 *
 * What the generate-a-payout screen defaults to: offering to pay the week in
 * progress would pay for work that has not finished happening.
 */
export function lastFullPayoutWeek(
  now = new Date(),
  timeZone?: string,
): PayoutWeek {
  const thisWeek = payoutWeekOf(now, timeZone);
  return payoutWeekOf(new Date(thisWeek.from.getTime() - DAY_MS), timeZone);
}

/** Local midnight starting the calendar date this midnight-UTC value names. */
function localMidnight(midnightUTC: Date, timeZone?: string): Date {
  return startOfZonedDay(
    partsToUTC(
      {
        year: midnightUTC.getUTCFullYear(),
        month: midnightUTC.getUTCMonth() + 1,
        day: midnightUTC.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    ),
    timeZone,
  );
}
