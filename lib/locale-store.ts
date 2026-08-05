import { cache } from 'react';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import {
  DEFAULT_LOCALE_CONFIG,
  type DistanceUnit,
  type LocaleConfig,
} from './locale';
import { prisma } from './prisma';

/**
 * Locale, read from and written to `Setting`.
 *
 * `lib/locale.ts` holds the constants and is reached from `lib/money.ts` and
 * `lib/dates.ts`, both of which run in the browser. The database read lives
 * here so those stay client-safe.
 *
 * Every value has a UK default, so a fresh install formats money and times
 * correctly before anyone opens Settings — but nothing outside this pair of
 * modules may write `'GBP'`, `'Europe/London'` or `20`.
 */

const KEYS: Record<keyof LocaleConfig, string> = {
  currency: 'locale.currency',
  locale: 'locale.locale',
  timeZone: 'locale.timeZone',
  taxName: 'locale.taxName',
  taxRatePct: 'locale.taxRatePct',
  distanceUnit: 'locale.distanceUnit',
};

/**
 * Validated against the platform's own ICU data rather than a hardcoded list.
 *
 * A currency or timezone the runtime cannot format is worse than the default:
 * it throws inside `Intl` at render time, on whichever page happens to show a
 * price first.
 */
function isSupportedCurrency(code: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(1);
    return true;
  } catch {
    return false;
  }
}

function isSupportedTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isSupportedLocale(tag: string): boolean {
  try {
    return Intl.NumberFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

export const localeSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isSupportedCurrency, {
      message: 'Use an ISO 4217 code this platform can format, such as GBP or EUR',
    }),
  locale: z.string().trim().refine(isSupportedLocale, {
    message: 'Use a BCP 47 tag such as en-GB or fr-FR',
  }),
  timeZone: z.string().trim().refine(isSupportedTimeZone, {
    message: 'Use an IANA timezone such as Europe/London or America/New_York',
  }),
  taxName: z.string().trim().min(1, 'Name the tax, e.g. VAT or Sales tax').max(40),
  taxRatePct: z.coerce
    .number()
    .min(0, 'A tax rate cannot be negative')
    .max(100, 'A tax rate above 100% is not a rate'),
  distanceUnit: z.enum(['miles', 'kilometres']),
});

export type LocaleInput = z.infer<typeof localeSchema>;

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function readLocaleConfig(): Promise<LocaleConfig> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.values(KEYS) } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const read = (field: keyof LocaleConfig) => byKey.get(KEYS[field]);

  const currency = asText(read('currency'));
  const locale = asText(read('locale'));
  const timeZone = asText(read('timeZone'));
  const distanceUnit = asText(read('distanceUnit'));
  const rate = Number(read('taxRatePct'));

  return {
    // Each field falls back on its own. A currency the platform cannot format
    // would otherwise throw inside `Intl` at render time.
    currency:
      currency && isSupportedCurrency(currency)
        ? currency
        : DEFAULT_LOCALE_CONFIG.currency,
    locale:
      locale && isSupportedLocale(locale) ? locale : DEFAULT_LOCALE_CONFIG.locale,
    timeZone:
      timeZone && isSupportedTimeZone(timeZone)
        ? timeZone
        : DEFAULT_LOCALE_CONFIG.timeZone,
    taxName: asText(read('taxName')) ?? DEFAULT_LOCALE_CONFIG.taxName,
    taxRatePct:
      Number.isFinite(rate) && rate >= 0 && rate <= 100
        ? rate
        : DEFAULT_LOCALE_CONFIG.taxRatePct,
    distanceUnit:
      distanceUnit === 'miles' || distanceUnit === 'kilometres'
        ? (distanceUnit as DistanceUnit)
        : DEFAULT_LOCALE_CONFIG.distanceUnit,
  };
}

export const getLocaleConfig = cache(async (): Promise<LocaleConfig> => {
  try {
    return await readLocaleConfig();
  } catch {
    return DEFAULT_LOCALE_CONFIG;
  }
});

export async function saveLocaleConfig(
  input: LocaleInput,
  context: AuditContext,
): Promise<void> {
  const before = await readLocaleConfig();

  await withAudit(
    'Setting',
    'update',
    async () => {
      await prisma.$transaction(
        (Object.keys(KEYS) as Array<keyof LocaleConfig>).map((field) =>
          prisma.setting.upsert({
            where: { key: KEYS[field] },
            update: { value: input[field] },
            create: { key: KEYS[field], value: input[field] },
          }),
        ),
      );
      const after = await readLocaleConfig();
      return { entityId: 'locale', before, after, result: null };
    },
    context,
  );
}

/** Money formatting options for the configured install. */
export async function getMoneyFormat(): Promise<{
  currency: string;
  locale: string;
}> {
  const config = await getLocaleConfig();
  return { currency: config.currency, locale: config.locale };
}
