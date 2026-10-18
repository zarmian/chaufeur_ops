import { BUILT_IN_ALIASES, PARSERS, type FieldAlias } from './fields';
import { findFlightInText, looksLikeAirport } from './flight';
import { postcodeOf } from './parse';
import {
  EMPTY_DRAFT,
  REQUIRED,
  findBy,
  toLines,
  type FieldSource,
  type JobSheetDraft,
  type ReadableField,
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

  for (const field of Object.keys(BUILT_IN_ALIASES) as ReadableField[]) {
    const aliases = [...(options.learned?.[field] ?? []), ...BUILT_IN_ALIASES[field]];
    const parse = PARSERS[field];

    for (const alias of aliases) {
      const candidates = findBy(
        alias.placement,
        lines,
        alias.label,
        alias.lineStart ?? false,
      );

      const hit = candidates
        .map((found) => parse(found.value))
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
