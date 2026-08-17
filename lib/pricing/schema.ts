import { z } from 'zod';

/**
 * Validation for the pricing configuration screens.
 *
 * Client-safe: this module imports nothing that reaches Postgres, so the same
 * schema validates in the browser and on the server — which is the only way
 * the two can be guaranteed to agree about what a valid rule is.
 *
 * Money arrives as typed text (`125.50`) and leaves as pence, because a form
 * field holding an integer number of pence is a form field people get wrong.
 */

/** `''` must not become `0`: `z.coerce.number()` would silently make it one. */
const blankToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === '' || value === undefined ? null : value),
    schema,
  );

const moneyText = z
  .string()
  .trim()
  .regex(/^-?[£$€]?\s*\d{1,9}(,\d{3})*(\.\d{1,2})?$/, 'Enter an amount like 125.50');

/** Pence from typed text. Blank counts as nothing charged, not as invalid. */
export function penceFrom(value: string | null | undefined): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned) return 0;
  return Math.round(Number(cleaned) * 100);
}

const optionalMoney = blankToNull(moneyText.nullable());

export const zoneSchema = z.object({
  name: z.string().trim().min(2, 'Give the zone a name').max(80),
  /** One prefix per line or comma-separated — people paste both ways. */
  postcodes: z.string().trim().max(2000).optional().or(z.literal('')),
  active: z.union([z.literal('on'), z.literal('')]).optional(),
});

export type ZoneInput = z.infer<typeof zoneSchema>;

/**
 * Postcode prefixes, however they were typed.
 *
 * Uppercased and de-duplicated, because `sw1` and `SW1 ` are the same claim
 * and two rows saying it would make the longest-prefix match ambiguous.
 */
export function parsePostcodes(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const part of input.split(/[\s,;]+/)) {
    const cleaned = part.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned) seen.add(cleaned);
  }
  return [...seen];
}

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date');

export const rateCardSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the rate card a name').max(120),
    activeFrom: dateField,
    activeTo: blankToNull(dateField.nullable()),
    isDefault: z.union([z.literal('on'), z.literal('')]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.activeTo && value.activeTo < value.activeFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeTo'],
        message: 'A card cannot stop applying before it starts.',
      });
    }
  });

export type RateCardInput = z.infer<typeof rateCardSchema>;

export const JOB_TYPE_VALUES = [
  'TRANSFER',
  'AIRPORT_TRANSFER',
  'AS_DIRECTED',
  'CONTRACT',
] as const;

/**
 * A rate card rule.
 *
 * The cross-field rules that matter — driver pay from a percentage *or* a
 * fixed amount but never both, and a rule that prices at nothing — are in
 * `ruleProblems` in `./resolve.ts`, because a rule can also arrive from a
 * seed or an import and a check that lives only in a form schema protects
 * only the form.
 */
export const rateRuleSchema = z.object({
  jobType: z.enum(JOB_TYPE_VALUES),
  vehicleClass: blankToNull(z.string().trim().max(40).nullable()),
  fromZoneId: blankToNull(z.string().trim().max(40).nullable()),
  toZoneId: blankToNull(z.string().trim().max(40).nullable()),

  baseFare: optionalMoney,
  perHour: optionalMoney,
  minimumHours: blankToNull(
    z.coerce.number().min(0).max(24, 'A minimum above 24 hours is a day rate').nullable(),
  ),
  perDay: optionalMoney,
  minimumDays: blankToNull(
    z.coerce.number().min(0).max(365, 'A minimum above a year is not a hire').nullable(),
  ),
  freeWaitMinutes: z.coerce.number().int().min(0).max(600),
  waitPerMinute: optionalMoney,

  driverBase: optionalMoney,
  driverPerHour: optionalMoney,
  driverPctOfFare: blankToNull(z.coerce.number().min(0).max(100).nullable()),

  priority: z.coerce.number().int().min(-100).max(100),
});

export type RateRuleInput = z.infer<typeof rateRuleSchema>;

export const locationSchema = z.object({
  label: z.string().trim().min(2, 'Give the location a name').max(120),
  address: z.string().trim().min(2, 'Enter the address').max(400),
  postcode: z.string().trim().max(12).optional().or(z.literal('')),
  zoneId: blankToNull(z.string().trim().max(40).nullable()),
  isAirport: z.union([z.literal('on'), z.literal('')]).optional(),
});

export type LocationInput = z.infer<typeof locationSchema>;

/** A checkbox that was ticked. Unticked checkboxes are simply absent. */
export function checked(value: unknown): boolean {
  return value === 'on' || value === true;
}
