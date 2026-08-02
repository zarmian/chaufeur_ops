/**
 * Timestamps are stored in UTC and displayed in the configured timezone.
 *
 * This matters more here than in most systems: a UK chauffeur operation
 * books pickups across both British Summer Time transitions every year, and
 * a naive local datetime puts a driver at Heathrow an hour late twice a year.
 *
 * Implemented with `Intl` alone — no date library — so there is no dependency
 * carrying its own tz database that can drift from the platform's.
 */

import { DEFAULT_TIMEZONE } from './locale';

export interface DateTimeParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

const PART_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading in `timeZone` at the given instant. */
export function getPartsInZone(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): DateTimeParts {
  const parts = partFormatter(timeZone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing ${type} formatting ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
}

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 * London is 0 in winter and +3600000 in summer.
 */
export function zoneOffsetMs(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  const p = getPartsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision from both sides so the difference is a clean
  // offset rather than offset-plus-milliseconds.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock reading in `timeZone` to the UTC instant it names.
 *
 * Two passes: guess by treating the wall clock as UTC, measure the offset
 * there, then re-measure at the corrected instant. The second pass is what
 * gets the hour either side of a DST transition right.
 *
 * Times that do not exist (the hour skipped when clocks go forward) shift
 * forward by the gap. Times that occur twice (when clocks go back) resolve
 * to the second, post-transition occurrence.
 */
export function partsToUTC(
  parts: DateTimeParts,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  const firstOffset = zoneOffsetMs(new Date(guess), timeZone);
  const firstAttempt = guess - firstOffset;

  const secondOffset = zoneOffsetMs(new Date(firstAttempt), timeZone);
  if (secondOffset === firstOffset) return new Date(firstAttempt);

  return new Date(guess - secondOffset);
}

const LOCAL_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parse a local datetime string — the value an `<input type="datetime-local">`
 * produces — as a wall-clock reading in `timeZone`, returning the UTC instant.
 *
 * `toUTC('2026-08-02T14:30')` is 13:30 UTC, because London is on BST in August.
 */
export function toUTC(
  localDateTime: string,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const match = LOCAL_DATETIME.exec(localDateTime.trim());
  if (!match) {
    throw new RangeError(
      `Expected a local datetime like 2026-08-02T14:30, got ${JSON.stringify(localDateTime)}`,
    );
  }
  const [, year, month, day, hour, minute, second] = match;
  return partsToUTC(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour ?? '0'),
      minute: Number(minute ?? '0'),
      second: Number(second ?? '0'),
    },
    timeZone,
  );
}

/**
 * The wall-clock reading of a UTC instant, as the `YYYY-MM-DDTHH:mm` string an
 * `<input type="datetime-local">` expects. Round-trips with `toUTC`.
 */
export function toLondon(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const p = getPartsInZone(instant, timeZone);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** True when the zone is on daylight saving time at that instant. */
export function isDST(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  const january = zoneOffsetMs(new Date(Date.UTC(instant.getUTCFullYear(), 0, 1)), timeZone);
  const july = zoneOffsetMs(new Date(Date.UTC(instant.getUTCFullYear(), 6, 1)), timeZone);
  const standard = Math.min(january, july);
  return zoneOffsetMs(instant, timeZone) > standard;
}

/** Midnight at the start of the instant's local day, as a UTC instant. */
export function startOfZonedDay(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const p = getPartsInZone(instant, timeZone);
  return partsToUTC(
    { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}

/**
 * The instant the local day ends — midnight starting the next day.
 * Exclusive, so range filters read `gte: start, lt: end` and never
 * double-count the boundary second.
 */
export function endOfZonedDay(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const start = startOfZonedDay(instant, timeZone);
  const nextDayish = new Date(start.getTime() + 36 * 60 * 60 * 1000);
  return startOfZonedDay(nextDayish, timeZone);
}

/**
 * A calendar date (no time) as stored in a `@db.Date` column.
 * Postgres `date` values come back as midnight UTC, so they must not be
 * shifted into a timezone on the way out.
 */
export function toDateOnlyString(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Parse `YYYY-MM-DD` into the midnight-UTC value a `@db.Date` column holds. */
export function fromDateOnlyString(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new RangeError(
      `Expected a date like 2026-08-02, got ${JSON.stringify(value)}`,
    );
  }
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/**
 * The last instant a document with this expiry date is still valid.
 *
 * Expiry is inclusive: a PHV badge expiring 14 July is valid through the end
 * of 14 July, local time. Getting this off by a day either bans a compliant
 * driver or lets a lapsed one work.
 */
export function endOfExpiryDay(
  expiresOn: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const iso = toDateOnlyString(expiresOn);
  const [year, month, day] = iso.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const startOfExpiryDay = partsToUTC(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return endOfZonedDay(startOfExpiryDay, timeZone);
}

const DISPLAY_CACHE = new Map<string, Intl.DateTimeFormat>();

/** Format an instant for display in the configured zone. */
export function formatInZone(
  instant: Date,
  options: Intl.DateTimeFormatOptions & { locale?: string; timeZone?: string } = {},
): string {
  const { locale = 'en-GB', timeZone = DEFAULT_TIMEZONE, ...rest } = options;
  const key = `${locale}|${timeZone}|${JSON.stringify(rest)}`;
  let formatter = DISPLAY_CACHE.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { timeZone, ...rest });
    DISPLAY_CACHE.set(key, formatter);
  }
  return formatter.format(instant);
}

/** `2 Aug 2026, 14:30` — the default job-list rendering. */
export function formatDateTime(
  instant: Date,
  options: { locale?: string; timeZone?: string } = {},
): string {
  return formatInZone(instant, {
    ...options,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** `2 Aug 2026` */
export function formatDate(
  instant: Date,
  options: { locale?: string; timeZone?: string } = {},
): string {
  return formatInZone(instant, {
    ...options,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Whole minutes between two instants, floored. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 60000);
}

/** Whole days from `from` to `to`, by local calendar day, not by 24h blocks. */
export function daysBetweenDates(
  from: Date,
  to: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  const a = startOfZonedDay(from, timeZone).getTime();
  const b = startOfZonedDay(to, timeZone).getTime();
  return Math.round((b - a) / 86400000);
}
