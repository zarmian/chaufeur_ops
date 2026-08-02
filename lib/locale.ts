/**
 * Locale is configuration, not constants.
 *
 * Phase 0 hard-codes the UK defaults here so there is exactly one place to
 * change. Phase 3 replaces the constants with values read from `Setting`,
 * without any caller needing to change — which is why nothing outside this
 * file may write `'GBP'`, `'Europe/London'`, `'£'` or `20`.
 */

export const DEFAULT_CURRENCY = 'GBP';
export const DEFAULT_LOCALE = 'en-GB';
export const DEFAULT_TIMEZONE = 'Europe/London';
export const DEFAULT_TAX_NAME = 'VAT';
export const DEFAULT_TAX_RATE_PCT = 20;
export const DEFAULT_DISTANCE_UNIT = 'miles' as const;

export type DistanceUnit = 'miles' | 'kilometres';

export interface LocaleConfig {
  currency: string;
  locale: string;
  timeZone: string;
  taxName: string;
  taxRatePct: number;
  distanceUnit: DistanceUnit;
}

export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  currency: DEFAULT_CURRENCY,
  locale: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIMEZONE,
  taxName: DEFAULT_TAX_NAME,
  taxRatePct: DEFAULT_TAX_RATE_PCT,
  distanceUnit: DEFAULT_DISTANCE_UNIT,
};
