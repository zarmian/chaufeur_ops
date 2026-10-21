import {
  BUILT_IN_ALIASES,
  PARSERS,
  aliasesFor,
  type FieldAlias,
  type SheetSource,
} from './fields';
import { findFlightInText, looksLikeAirport } from './flight';
import { parseSheetDate, postcodeOf, type DateOrder } from './parse';
import {
  EMPTY_DRAFT,
  REQUIRED,
  cellsOf,
  findBy,
  looksLikeLabel,
  tidyRun,
  toLines,
  type FieldSource,
  type JobSheetDraft,
  type ReadableField,
  type SheetLine,
  type SheetRead,
} from './types';

/**
 * Reading a sheet: labels in, form values out.
 *
 * One reader for every agency. Each field is looked for under each of its known
 * labels in turn, and the first candidate its parser accepts is taken. A label
 * whose box was left blank yields nothing and the search moves on, which is how
 * a sheet with an empty `Trip Total` and a filled `Total` still finds a price.
 *
 * Learned labels are tried before the built-in ones, because they were taught
 * by an operator looking at this sender's own paperwork and are therefore
 * better evidence than a general guess.
 */

export interface ReadOptions {
  /**
   * Labels learned from this sender's earlier sheets.
   *
   * See `lib/job-sheets/store.ts`. This is the whole of the learning: an
   * operator corrects a field once, the label that should have produced it is
   * recorded against the sender, and the next sheet reads it without help.
   */
  learned?: Partial<Record<ReadableField, FieldAlias[]>>;
  /**
   * Whether this text was printed by software or typed by a person.
   *
   * Decides how far the vocabulary can be trusted — see `SheetSource`. A
   * printed sheet carries every field it has whether or not it was filled, so
   * a bare `Date:` is as likely to be the one beside `Signature:` as the
   * pickup date. Somebody typing a booking types one date.
   *
   * Defaults to `sheet`, which is the stricter reading: a caller that has not
   * thought about it gets the one that refuses rather than the one that
   * guesses.
   */
  source?: SheetSource;
  /**
   * Which way round this source writes an all-numeric date.
   *
   * No default, deliberately. Unset, `20-10-2026` is still refused, because
   * on a sheet from an agency nobody has configured it genuinely cannot be
   * told from `10-20-2026`. Set, it is read — an office's own template is
   * written the same way every time, and somebody can simply say which.
   */
  dateOrder?: DateOrder;
}

/**
 * Where a sender's standing instructions begin.
 *
 * Everything below is prose about driver conduct, identical on every sheet they
 * send: how to dress, how long to wait before a no-show, who to telephone. It
 * is not about this booking, and two things depend on knowing where it starts —
 * the notes stop there, and the search for a flight number in free text stops
 * there too, since "drivers must be on location at flight landing time" is not
 * a flight.
 */
const STANDING_INSTRUCTIONS =
  /IMPORTANT INSTRUCTIONS|TERMS (?:AND|&) CONDITIONS|STANDING INSTRUCTIONS|DRIVER (?:RULES|CODE)/i;

export function readJobSheet(text: string, options: ReadOptions = {}): SheetRead {
  const lines = toLines(text);
  const draft: JobSheetDraft = { ...EMPTY_DRAFT };
  const sources: Partial<Record<ReadableField, FieldSource>> = {};

  const source = options.source ?? 'sheet';

  for (const field of Object.keys(BUILT_IN_ALIASES) as ReadableField[]) {
    const aliases = aliasesFor(field, source, options.learned?.[field]);
    const parse = PARSERS[field];

    for (const alias of aliases) {
      const candidates = findBy(
        alias.placement,
        lines,
        alias.label,
        alias.lineStart ?? false,
      );

      const hit = candidates
        .filter((found) => found.line < boundary(lines, alias.notAfter))
        .map((found) =>
          field === 'scheduledDate'
            ? parseSheetDate(found.value, options.dateOrder)
            : parse(found.value),
        )
        .find((value): value is string => value !== null);

      if (hit !== undefined) {
        draft[field] = hit;
        sources[field] = { label: alias.label, placement: alias.placement };
        break;
      }
    }
  }

  derive(draft, text);

  const missing = REQUIRED.filter(({ key }) => draft[key] === null).map(
    ({ said }) => said,
  );

  return { draft, missing, sources };
}

/**
 * The line a field's own block ends at, or the end of the text.
 *
 * Cheap enough to recompute per alias — these are a few dozen lines — and
 * keeping it a function of the text rather than state means a template whose
 * blocks appear in a different order needs no special case.
 */
function boundary(lines: SheetLine[], notAfter: string[] | undefined): number {
  if (!notAfter || notAfter.length === 0) return lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.text.toLowerCase();
    if (notAfter.some((label) => text.includes(label.toLowerCase()))) return index;
  }

  return lines.length;
}

/**
 * The fields no label produces: the postcodes, a flight hiding in prose, and
 * the job type.
 */
function derive(draft: JobSheetDraft, text: string): void {
  draft.pickupPostcode = postcodeOf(draft.pickupText);
  draft.dropoffPostcode = postcodeOf(draft.dropoffText);

  if (!draft.flightNumber) {
    /*
     * Agencies habitually bury the flight in the notes rather than giving it a
     * box — "arriving on BA117" — and on a sheet with no flight field that is
     * the only place it exists. Searched above the standing instructions only.
     */
    const bookingPart = text.split(STANDING_INSTRUCTIONS)[0] ?? text;
    const found = findFlightInText(bookingPart);

    // A reference that happens to be flight-shaped is not a flight. The sample
    // sheet's reservation number is 30700; an agency using "BA" as a prefix
    // would otherwise send every job to a flight lookup.
    if (found && found !== draft.customerReference?.toUpperCase()) {
      draft.flightNumber = found;
    }
  }

  draft.jobType = inferJobType(draft, text);
}

/**
 * Pick the job type the sheet implies.
 *
 * A suggestion on a form the operator reads, not a ruling — but a consequential
 * one, and getting it wrong is quietly expensive in both directions. The free
 * wait-time allowance is 45 minutes for an airport arrival and 15 otherwise, so
 * a misclassified airport job starts charging waiting half an hour early and a
 * misclassified transfer gives away half an hour. And the form only shows the
 * flight number field on an airport transfer, so a flight found on a job typed
 * as a plain transfer would be read off the sheet and then silently dropped.
 */
function inferJobType(draft: JobSheetDraft, text: string): string {
  if (draft.flightNumber) return 'AIRPORT_TRANSFER';
  if (looksLikeAirport(draft.pickupText) || looksLikeAirport(draft.dropoffText)) {
    return 'AIRPORT_TRANSFER';
  }

  /*
   * Hourly hire, where the sheet says so in those words. Checked after the
   * airport tests because "as directed from Heathrow" is an airport job that
   * then runs on, and its wait-time allowance is the airport one.
   */
  const bookingPart = (text.split(STANDING_INSTRUCTIONS)[0] ?? text).toLowerCase();
  if (/\bas directed\b|\bat disposal\b|\bhourly hire\b|\bby the hour\b/.test(bookingPart)) {
    return 'AS_DIRECTED';
  }

  return 'TRANSFER';
}

/**
 * A guess at who sent the sheet, from its own letterhead.
 *
 * Only ever a suggestion in a box an operator checks. It exists because the
 * alternative is an empty field on a page that is already asking somebody to
 * do administration before they can book a car, and because the name is also
 * the fingerprint — so a bad guess left unchecked would claim another agency's
 * sheets, and recognising the wrong sender bills the wrong company.
 *
 * The signal is repetition. An agency's name appears in the letterhead and
 * again in the footer; a document title like "BOOKING CONFIRMATION" appears
 * once. Where nothing repeats, the earliest candidate wins, which is the
 * letterhead.
 */
export function guessSenderName(text: string): string {
  const counts = new Map<string, { name: string; count: number; first: number }>();
  let position = 0;

  for (const line of toLines(text)) {
    for (const cell of cellsOf(line)) {
      // A footer runs the name into a registration — "… Ltd - PCO 010328".
      for (const piece of cell.text.split(/\s+[-–]\s+/)) {
        position += 1;
        const name = tidyCompany(piece);
        if (!name) continue;

        const key = name.toLowerCase();
        const seen = counts.get(key);
        if (seen) seen.count += 1;
        else counts.set(key, { name, count: 1, first: position });
      }
    }
  }

  const best = [...counts.values()].sort(
    (left, right) => right.count - left.count || left.first - right.first,
  )[0];

  return best?.name ?? '';
}

/** A cell that could be a company's name, with its corporate suffix removed. */
function tidyCompany(raw: string): string | null {
  const value = tidyRun(raw).replace(
    /[,.]?\s+(?:Ltd|Limited|LLP|PLC|Inc|LLC)\.?$/i,
    '',
  );

  if (value.length < 6 || value.length > 50) return null;
  if (looksLikeLabel(value)) return null;
  // A name carries no digits, no address punctuation and no email.
  if (/[\d@:#/]/.test(value)) return null;

  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 5) return null;

  // Each word capitalised, or the whole thing set in capitals as a letterhead
  // usually is.
  return words.every((word) => /^[A-Z&][A-Za-z&']*$/.test(word)) ? value : null;
}
