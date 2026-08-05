import { z } from 'zod';
import { parseMoney } from './money';

/**
 * Just the two price fields, for bulk entry.
 *
 * Separate from `jobSchema` because backfilling a price must not require
 * re-supplying a pickup, a destination and a time for every row — the whole
 * point is to fix hundreds of imported jobs at once.
 *
 * A blank field means "leave this one alone", which is why both sides are
 * nullable and the caller checks that at least one was given.
 */

const optionalPrice = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))
  .superRefine((value, ctx) => {
    if (value === null) return;
    try {
      if (parseMoney(value) < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'That cannot be negative',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter an amount like 125.50',
      });
    }
  })
  .transform((value) => (value === null ? null : parseMoney(value)));

export const jobPriceSchema = z.object({
  clientPrice: optionalPrice,
  driverPrice: optionalPrice,
});

export type JobPriceInput = z.infer<typeof jobPriceSchema>;
