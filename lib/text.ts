/**
 * Normalisation for duplicate detection.
 *
 * The legacy system stored client names as free text per job, so "MR Yinka",
 * "Mr yinka" and "Mr. Yinka " were three different clients. These functions
 * produce the comparison key that stops that happening again — they are for
 * matching only, never for display. The name the operator typed is always
 * what gets shown.
 */

/**
 * Titles stripped before comparison. Deliberately conservative: removing too
 * much merges genuinely different people, which is worse than missing a
 * duplicate the operator can still spot.
 */
const HONORIFICS = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'dr',
  'prof',
  'professor',
  'sir',
  'dame',
  'lord',
  'lady',
  'rev',
  'reverend',
  'capt',
  'captain',
  'major',
  'col',
  'colonel',
  'hon',
]);

/**
 * `"Mr. Yinka  Adeyemi"` -> `"yinka adeyemi"`.
 *
 * Lowercased, punctuation removed, whitespace collapsed, honorifics dropped.
 * Accents are folded too, so "Renée" and "Renee" match.
 */
export function normaliseName(input: string): string {
  const folded = input
    .normalize('NFKD')
    // Strip combining marks left behind by the decomposition.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes vanish rather than becoming spaces, so O'Brien stays one
    // word; everything else becomes a separator.
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (folded === '') return '';

  const words = folded.split(' ');
  const withoutHonorifics = words.filter(
    (word, index) => !(index === 0 && HONORIFICS.has(word)),
  );

  // A name that is *only* an honorific keeps it, rather than normalising to
  // nothing and matching every other empty name.
  const kept = withoutHonorifics.length > 0 ? withoutHonorifics : words;
  return kept.join(' ');
}

/**
 * `"kr22 rrz"` -> `"KR22RRZ"`.
 *
 * Registrations are compared without spaces or case, because the same plate
 * gets typed `KR22RRZ`, `KR22 RRZ` and `kr22-rrz`. The original spacing is
 * preserved on the record for display — a plate reads wrong without it.
 */
export function normaliseRegistration(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Digits only, so `+44 7700 900123`, `07700 900123` and `07700900123` compare
 * equal. Used as the natural key when importing drivers.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, '');
  // A UK number given in international form is the same number as the one
  // starting 0. Fold to the national form for comparison.
  if (digits.startsWith('+44')) return `0${digits.slice(3)}`;
  if (digits.startsWith('0044')) return `0${digits.slice(4)}`;
  return digits.replace(/\+/g, '');
}

/**
 * A normalised search term, or null when normalising left nothing behind.
 *
 * The distinction is the difference between a search that works and one that
 * silently returns the whole table. `contains: ''` is `LIKE '%%'` in SQL — it
 * matches **every** row, not none — and every normaliser above strips
 * characters, so a term can normalise away to nothing while the operator has
 * plainly typed something. `normalisePhone('Dispatch')` is `''`.
 *
 * That is not hypothetical. The driver list ran `phone contains
 * normalisePhone(q)` unguarded, so searching for a name — the commonest thing
 * anybody does on that screen — matched all 152 drivers instead of the 82 whose
 * name contained the word. The list came back looking exactly as it had before,
 * which reads as a search box that does nothing at all.
 *
 * Null is the correct answer, and callers drop the clause: a term that holds
 * no digits cannot be a phone number, so the right number of phone matches is
 * zero, and the other clauses in the `OR` decide the result.
 */
export function normalisedSearchTerm(
  raw: string,
  normalise: (input: string) => string,
): string | null {
  const value = normalise(raw);
  return value === '' ? null : value;
}

/** Trim and collapse internal whitespace, without changing case. */
export function tidy(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** `null` for an empty or whitespace-only string, so optional columns stay null. */
export function emptyToNull(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = tidy(input);
  return trimmed === '' ? null : trimmed;
}
