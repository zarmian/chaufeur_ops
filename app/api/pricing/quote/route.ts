import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { getLocaleConfig } from '@/lib/locale-store';
import { scheduledAtFrom } from '@/lib/jobs';
import { suggestPrice } from '@/lib/pricing/rate-card';

/**
 * `POST /api/pricing/quote` — what the rate card says this booking costs.
 *
 * Saves nothing. It answers a question the booking form asks while the
 * operator is still typing, and the answer pre-fills two fields they remain
 * free to overwrite. What they leave in the fields is what gets stored: the
 * price is a commercial agreement, not a calculation.
 *
 * A miss is `200` with `{ suggestion: null }`, not a `404`. Most bookings
 * never match a rule, and a form that treated "no suggestion" as an error
 * would show a red box on the majority of perfectly normal calls.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  jobType: z.enum(['TRANSFER', 'AIRPORT_TRANSFER', 'AS_DIRECTED']),
  vehicleClass: z
    .enum(['SALOON', 'EXECUTIVE', 'LUXURY', 'MPV', 'SUV', 'ELECTRIC_EXECUTIVE'])
    .nullable()
    .optional(),
  accountId: z.string().trim().nullable().optional(),
  clientId: z.string().trim().nullable().optional(),
  pickupText: z.string().trim().max(500).nullable().optional(),
  dropoffText: z.string().trim().max(500).nullable().optional(),
  /**
   * From an address lookup, when the operator chose a suggestion.
   *
   * Spec 4.8.6.7: a correctly-picked address prices correctly. Passing the
   * postcode lets the matcher resolve a zone by prefix rather than by hoping
   * the typed text happens to name one — "53 Park Lane" names no zone at all,
   * but W1K does.
   */
  pickupPostcode: z.string().trim().max(12).nullable().optional(),
  dropoffPostcode: z.string().trim().max(12).nullable().optional(),
  /** `YYYY-MM-DD` and `HH:mm`, as the form holds them. */
  scheduledDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduledTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
  hours: z.coerce.number().min(0).max(24).nullable().optional(),
  days: z.coerce.number().min(0).max(365).nullable().optional(),
});

export const POST = withErrorHandling(async (request: Request): Promise<Response> => {
  // `viewJobs` rather than `editJobs`: this only reads the rate card, and the
  // booking form is reachable by anyone who can see jobs.
  await requireCapability('viewJobs');

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(
      'VALIDATION_FAILED',
      parsed.error.errors[0]?.message ?? 'That is not a booking',
    );
  }

  const input = parsed.data;
  const { timeZone } = await getLocaleConfig();

  // The form holds wall-clock time in the configured zone; the rate card is
  // chosen by the instant. Shared with `createJob` rather than reimplemented,
  // so a quote and the job it becomes are priced on the same card — getting
  // this wrong would price a 00:30 booking on the previous day's card twice
  // a year.
  const scheduledAt = scheduledAtFrom(
    { scheduledDate: input.scheduledDate, scheduledTime: input.scheduledTime },
    timeZone,
  );

  const suggestion = await suggestPrice({
    jobType: input.jobType,
    vehicleClass: input.vehicleClass ?? null,
    accountId: input.accountId ?? null,
    clientId: input.clientId ?? null,
    pickupText: input.pickupText ?? null,
    dropoffText: input.dropoffText ?? null,
    pickupPostcode: input.pickupPostcode ?? null,
    dropoffPostcode: input.dropoffPostcode ?? null,
    hours: input.hours ?? null,
    days: input.days ?? null,
    scheduledAt,
  });

  return NextResponse.json({ suggestion });
});
