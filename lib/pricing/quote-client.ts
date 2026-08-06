/**
 * Asking the rate card what a booking costs, from the browser.
 *
 * Client-safe by construction: this module imports nothing, so the booking
 * form can use it without dragging Prisma into the bundle. The shape it
 * returns mirrors `RateSuggestion` in `./rate-card.ts` — declared again
 * rather than imported, because importing that file would pull the whole
 * server module in behind the type.
 */

export interface QuoteInput {
  jobType: string;
  vehicleClass?: string | null;
  accountId?: string | null;
  clientId?: string | null;
  pickupText?: string | null;
  dropoffText?: string | null;
  /** From an address lookup. Resolves a zone by prefix rather than by name. */
  pickupPostcode?: string | null;
  dropoffPostcode?: string | null;
  scheduledDate: string;
  scheduledTime: string;
  hours?: number | null;
}

export interface Quote {
  rateCardRuleId: string;
  clientPricePence: number;
  driverPricePence: number | null;
  freeWaitMinutes: number;
  explanation: string;
  fromZoneName: string | null;
  toZoneName: string | null;
}

/**
 * Everything the matcher needs before it is worth asking — spec 4.2.7.
 *
 * Without a route and a date there is nothing to match on, and a request per
 * keystroke into an empty form is noise the operator would see as a price
 * flickering while they type.
 */
export function quoteIsWorthAsking(input: Partial<QuoteInput>): boolean {
  return Boolean(
    input.jobType &&
      input.scheduledDate &&
      input.scheduledTime &&
      input.pickupText?.trim() &&
      input.dropoffText?.trim(),
  );
}

/**
 * A quote, or null.
 *
 * Null covers both "nothing matched" and "the request failed". Neither is an
 * error the operator needs to see: the phone call is happening either way,
 * and the price fields work perfectly well without a suggestion.
 */
export async function fetchQuote(
  input: QuoteInput,
  signal?: AbortSignal,
): Promise<Quote | null> {
  try {
    const response = await fetch('/api/pricing/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();
    const suggestion = (body as { suggestion?: Quote | null })?.suggestion;
    return suggestion ?? null;
  } catch {
    return null;
  }
}

/** Pence as the price fields hold it: `12550` becomes `"125.50"`. */
export function penceToField(pence: number | null): string {
  if (pence === null) return '';
  return (pence / 100).toFixed(2);
}
