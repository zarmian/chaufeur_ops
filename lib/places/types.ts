/**
 * Address lookup, behind a seam.
 *
 * Google Places is the first implementation because its coverage of named
 * places — "The Dorchester", "Heathrow T5" — is what a chauffeur operator
 * actually types into a pickup field. But nothing above this file knows that:
 * a second provider can be added without touching the booking form, and the
 * system works with none configured at all.
 *
 * Pure types and pure helpers. Nothing here reaches the network or the
 * database, so the booking form can import it without dragging a key into the
 * browser bundle.
 */

export type PlaceProviderName = 'google' | 'postcodes' | 'none';

/** One thing an operator can pick. */
export interface PlaceSuggestion {
  /** Opaque to us; meaningful to whichever provider produced it. */
  id: string;
  /** The line shown in bold — "The Dorchester". */
  primary: string;
  /** The line shown underneath — "Park Lane, Mayfair, London". */
  secondary: string;
  /** Present when the provider gave it without a second lookup. */
  postcode?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** `saved` marks a Location already in the database. */
  source: 'saved' | 'google' | 'postcodes';
}

/** What choosing a suggestion resolves to. */
export interface PlaceDetail {
  label: string;
  address: string;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
}

export interface PlaceProvider {
  name: PlaceProviderName;
  /**
   * Suggestions for what has been typed so far.
   *
   * `sessionToken` groups the keystrokes of one search. Google bills a
   * session, not a request, so passing it turns a bill per keystroke into a
   * bill per address — which is the difference between this feature being
   * affordable and not.
   */
  suggest(
    query: string,
    options: { sessionToken?: string; signal?: AbortSignal },
  ): Promise<PlaceSuggestion[]>;

  /** Resolve a chosen suggestion. Null when it cannot be resolved. */
  detail(
    id: string,
    options: { sessionToken?: string; signal?: AbortSignal },
  ): Promise<PlaceDetail | null>;
}

/**
 * A UK postcode, if the text contains one.
 *
 * The outward and inward halves may be written together or apart, and an
 * operator types both. Returned in the canonical spaced, upper-cased form
 * because that is what zone resolution and every downstream comparison
 * expects.
 */
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

export function extractPostcode(input: string): string | null {
  const match = POSTCODE.exec(input);
  if (!match) return null;
  return `${match[1]!.toUpperCase()} ${match[2]!.toUpperCase()}`;
}

/**
 * Whether a query is worth sending to a paid provider.
 *
 * Two characters match half of London and cost the same as a good query.
 * Refusing them locally is the cheapest optimisation available.
 */
export function worthAsking(query: string): boolean {
  return query.trim().length >= 3;
}

/**
 * A session token.
 *
 * Any opaque unique string will do; Google only uses it to group requests.
 * Generated in the browser and thrown away once a suggestion is chosen.
 */
export function newSessionToken(): string {
  // `crypto.randomUUID` is in every browser this ships to, and in Node 18+.
  return globalThis.crypto?.randomUUID?.() ?? `s${Date.now()}${Math.random()}`;
}
