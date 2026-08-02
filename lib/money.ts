/**
 * Money is an integer count of the currency's minor unit — pence for GBP.
 *
 * Nothing outside this module converts between the stored integer and a
 * human-readable string. Floats never hold money: a `Float` column is how
 * you end up with £125.4999999999 in a ledger that has to reconcile.
 */

import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from './locale';

export interface MoneyFormatOptions {
  currency?: string;
  locale?: string;
  /** Omit the currency symbol — for spreadsheet cells and CSV columns. */
  bare?: boolean;
}

export class InvalidMoneyError extends Error {
  constructor(input: string) {
    super(`Not a valid monetary amount: ${JSON.stringify(input)}`);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * Round to a whole minor unit, half away from zero.
 *
 * `2.5 -> 3`, `-2.5 -> -3`. JavaScript's `Math.round` rounds half *up*, so
 * `-2.5` would become `-2` and a credit note would disagree with the invoice
 * it reverses by a penny. Every derived total goes through this function so
 * the rounding is identical everywhere.
 */
export function roundPence(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite amount: ${value}`);
  }
  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  // Normalise -0, which is not `Object.is`-equal to 0 and breaks assertions.
  return rounded === 0 ? 0 : rounded;
}

/** How many decimal places the currency's minor unit occupies (GBP: 2). */
export function minorUnitDigits(
  currency: string = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE,
): number {
  const resolved = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).resolvedOptions();
  return resolved.maximumFractionDigits ?? 2;
}

/**
 * Render a minor-unit integer for display. `12550 -> "£125.50"`.
 *
 * The currency and locale are parameters rather than constants so a non-UK
 * install is a settings change. `formatGBP` below is the UK default.
 */
export function formatMoney(
  minorUnits: number,
  options: MoneyFormatOptions = {},
): string {
  const {
    currency = DEFAULT_CURRENCY,
    locale = DEFAULT_LOCALE,
    bare = false,
  } = options;

  if (!Number.isFinite(minorUnits)) {
    throw new RangeError(`Cannot format a non-finite amount: ${minorUnits}`);
  }

  const digits = minorUnitDigits(currency, locale);
  const major = minorUnits / 10 ** digits;

  return new Intl.NumberFormat(locale, {
    style: bare ? 'decimal' : 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);
}

/** UK default. Kept as the name the rest of the codebase reaches for. */
export function formatGBP(pence: number): string {
  return formatMoney(pence);
}

/**
 * Parse a typed amount into minor units. Accepts `"£125.50"`, `"125.50"`,
 * `"1,234.56"` and `"-12.50"`.
 *
 * Group separators are stripped; the decimal separator is a full stop. The
 * lenient comma-as-decimal form that drivers type into Telegram is handled
 * separately in Phase 5, where the ambiguity is worth the risk.
 */
export function parseMoney(
  input: string,
  options: Pick<MoneyFormatOptions, 'currency' | 'locale'> = {},
): number {
  const parsed = tryParseMoney(input, options);
  if (parsed === null) throw new InvalidMoneyError(input);
  return parsed;
}

/** As `parseMoney`, but returns null instead of throwing. */
export function tryParseMoney(
  input: string,
  options: Pick<MoneyFormatOptions, 'currency' | 'locale'> = {},
): number | null {
  const { currency = DEFAULT_CURRENCY, locale = DEFAULT_LOCALE } = options;

  if (typeof input !== 'string') return null;

  // Strip currency symbols, letters, whitespace (including non-breaking and
  // narrow no-break spaces, which Intl emits as group separators) and group
  // commas. Keep digits, a sign and a decimal point.
  const cleaned = input
    .trim()
    .replace(/[\p{Sc}\p{L}]/gu, '')
    .replace(/[\s  ]/g, '')
    .replace(/,/g, '');

  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;
  if (!/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;

  const major = Number(cleaned);
  if (!Number.isFinite(major)) return null;

  const digits = minorUnitDigits(currency, locale);
  return roundPence(major * 10 ** digits);
}

/** UK default, matching `formatGBP`. */
export function parseGBP(input: string): number {
  return parseMoney(input);
}

/**
 * Margin as a percentage of revenue, to two decimal places.
 *
 * Zero revenue returns null rather than 0 — a job with no price has no
 * margin, and reporting it as 0% is exactly the silent-zero problem this
 * system exists to fix.
 */
export function marginPct(
  revenuePence: number,
  grossProfitPence: number,
): number | null {
  if (revenuePence === 0) return null;
  return Math.round((grossProfitPence / revenuePence) * 10000) / 100;
}

/** Sum minor-unit integers. Present so totals are never built with `+` inline. */
export function sumPence(...amounts: Array<number | null | undefined>): number {
  return amounts.reduce<number>((total, amount) => total + (amount ?? 0), 0);
}
