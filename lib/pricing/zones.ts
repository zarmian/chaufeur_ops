/**
 * Matching what an operator typed to a zone.
 *
 * The pickup field is free text taken down during a phone call. "London
 * Heathrow airport terminal 5", "LHR T5", "heathrow t5" and "Terminal 5,
 * Heathrow" are the same place, and a rate card that only recognises one of
 * them prices three of those bookings wrong — or, worse, prices none of them
 * and quietly falls back to whatever the operator types.
 *
 * Two signals, in order of trust:
 *
 * 1. **The postcode.** Unambiguous when present, so it wins outright.
 * 2. **The text.** Alias matching, deliberately conservative: a phrase must
 *    be a recognisable name for the place, not merely contain a word that
 *    appears in it. "Kingsway" is not Kings Cross.
 *
 * A miss returns null and is recorded, because the list of things this fails
 * on is the specification for improving it. Guessing would be worse: a wrong
 * zone produces a confidently wrong price.
 *
 * Imports nothing, so the matcher can run in the browser as the operator
 * types.
 */

export interface ZoneRecord {
  id: string;
  name: string;
  /** Postcode prefixes, e.g. `TW6`. */
  postcodes: string[];
}

export type ZoneMatchBy = 'postcode' | 'alias' | 'name';

export interface ZoneMatch {
  zoneId: string;
  zoneName: string;
  by: ZoneMatchBy;
  /** What in the input caused the match, for showing the operator. */
  matched: string;
}

/**
 * Extra names for the seeded zones.
 *
 * Airports carry the most: an IATA code, the airport's own name, and the
 * terminal strings people actually say. Every entry here is a phrase that
 * unambiguously means that zone — anything that could mean two places belongs
 * in neither list.
 */
export const ZONE_ALIASES: Record<string, string[]> = {
  Heathrow: [
    'heathrow',
    'lhr',
    'london heathrow',
    'heathrow airport',
    'london heathrow airport',
  ],
  Gatwick: [
    'gatwick',
    'lgw',
    'london gatwick',
    'gatwick airport',
    'london gatwick airport',
  ],
  Luton: ['luton', 'ltn', 'london luton', 'luton airport', 'london luton airport'],
  Stansted: [
    'stansted',
    'stanstead',
    'stn',
    'london stansted',
    'stansted airport',
  ],
  'London City': [
    'london city airport',
    'city airport',
    'lcy',
    'london city',
  ],
  'Central London': ['central london', 'west end', 'the city', 'city of london'],
};

/** Zones that are airports, where terminal strings are worth understanding. */
export const AIRPORT_ZONES = [
  'Heathrow',
  'Gatwick',
  'Luton',
  'Stansted',
  'London City',
];

/** Lower-cased, punctuation flattened, whitespace collapsed. */
export function normaliseText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The outward code of a UK postcode — `SW1A 1AA` gives `SW1A`.
 *
 * Returns null rather than guessing when the text does not contain one.
 * Matching a fragment that merely looks like a postcode would put a booking
 * in the wrong zone with no way to tell.
 */
export function extractOutwardCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ');

  // Full postcode first: the outward code is unambiguous when the inward
  // code follows it.
  const full = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/.exec(cleaned);
  if (full) return full[1]!;

  // A bare outward code, but only when it stands alone — otherwise "A1" in a
  // street name would be read as a postcode.
  const outward = /(?:^|\s)([A-Z]{1,2}\d[A-Z\d]?)(?:\s|$)/.exec(cleaned);
  return outward ? outward[1]! : null;
}

/**
 * Which zone a postcode belongs to.
 *
 * The longest matching prefix wins. `TW6` is Heathrow and `TW` is Greater
 * London, and a shortest-match rule would put every Heathrow pickup in
 * Greater London — which is exactly the sort of quietly wrong answer that
 * makes a rate card untrustworthy.
 */
export function zoneForPostcode(
  outwardCode: string,
  zones: ZoneRecord[],
): ZoneMatch | null {
  const code = outwardCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code === '') return null;

  let best: { zone: ZoneRecord; prefix: string } | null = null;

  for (const zone of zones) {
    for (const prefix of zone.postcodes) {
      const upper = prefix.toUpperCase();
      if (!code.startsWith(upper)) continue;
      // A prefix must end on a boundary: `E1` must not match zone `E16`, and
      // zone `E1` must not claim postcode `E16`. Comparing lengths handles
      // the first; this handles the second.
      if (best === null || upper.length > best.prefix.length) {
        best = { zone, prefix: upper };
      }
    }
  }

  return best
    ? {
        zoneId: best.zone.id,
        zoneName: best.zone.name,
        by: 'postcode',
        matched: best.prefix,
      }
    : null;
}

/**
 * Which zone a phrase names.
 *
 * Matched on word boundaries against the normalised text, longest alias
 * first, so "london city airport" is not beaten by "london city" and
 * "heathrow airport" is preferred over "heathrow" for reporting what matched.
 */
export function zoneForText(
  text: string,
  zones: ZoneRecord[],
  aliases: Record<string, string[]> = ZONE_ALIASES,
): ZoneMatch | null {
  const haystack = normaliseText(text);
  if (haystack === '') return null;

  const candidates: Array<{ zone: ZoneRecord; phrase: string; by: ZoneMatchBy }> =
    [];

  for (const zone of zones) {
    const phrases = [
      ...(aliases[zone.name] ?? []).map((phrase) => ({
        phrase: normaliseText(phrase),
        by: 'alias' as ZoneMatchBy,
      })),
      { phrase: normaliseText(zone.name), by: 'name' as ZoneMatchBy },
    ];

    for (const { phrase, by } of phrases) {
      if (phrase === '') continue;
      // Word-boundary containment: "kingsway" must not match "kings".
      const pattern = new RegExp(`(^| )${escapeRegExp(phrase)}( |$)`);
      if (pattern.test(haystack)) candidates.push({ zone, phrase, by });
    }
  }

  if (candidates.length === 0) return null;

  // The longest phrase is the most specific claim about the text.
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);
  const winner = candidates[0]!;

  return {
    zoneId: winner.zone.id,
    zoneName: winner.zone.name,
    by: winner.by,
    matched: winner.phrase,
  };
}

/**
 * Resolve free text, and an optional postcode, to a zone.
 *
 * The postcode wins when it resolves: it is a fact, where the text is a
 * description. An operator who typed "Heathrow" into a booking whose postcode
 * is in Croydon has made a mistake somewhere, and the postcode is the half
 * more likely to be right.
 */
export function resolveZone(
  text: string,
  zones: ZoneRecord[],
  postcode?: string | null,
): ZoneMatch | null {
  const outward = postcode
    ? extractOutwardCode(postcode)
    : extractOutwardCode(text);

  if (outward) {
    const byPostcode = zoneForPostcode(outward, zones);
    if (byPostcode) return byPostcode;
  }

  return zoneForText(text, zones);
}

/**
 * The terminal named in a pickup string, if any.
 *
 * Not used for zone matching — every terminal at Heathrow is Heathrow — but
 * worth keeping: it is what tells a driver which door to go to, and it is the
 * difference between a useful job sheet and a vague one.
 */
export function extractTerminal(text: string): string | null {
  const normalised = normaliseText(text);
  const match =
    /(?:^| )(?:terminal|term|t) ?(\d)(?: |$)/.exec(normalised) ??
    /(?:^| )t(\d)(?: |$)/.exec(normalised);
  return match ? `Terminal ${match[1]}` : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
