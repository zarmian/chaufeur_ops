import { BUILT_IN_ALIASES, PARSERS, type FieldAlias } from './fields';
import {
  cellsOf,
  findBy,
  toLines,
  type FieldSource,
  type JobSheetDraft,
  type Placement,
  type ReadableField,
} from './types';

/**
 * Learning a sender's own wording.
 *
 * The built-in dictionary knows the labels in general circulation. This is how
 * an install comes to know the ones a particular agency uses, without a code
 * change and without anybody being asked to configure anything: a field the
 * reader could not find, filled in by the operator on the booking form, is
 * enough to work out which label it should have looked under.
 *
 * **It learns from a gap, not from a disagreement.** That distinction is the
 * whole safety of this. When a field arrives blank and the operator types a
 * value, the only explanation is that the label was unknown — so finding which
 * label on the page would have produced that value is sound inference. When a
 * field arrives filled and the operator *changes* it, the likeliest
 * explanation is that the agency wrote the wrong thing on the sheet, which
 * teaches nothing about labels; inventing one from it would mean learning
 * whatever unrelated box happened to contain a matching value. A correction is
 * recorded as a tally against the label that produced it, and a label that is
 * changed more often than it is kept is retired.
 *
 * Pure. Every rule here is a test rather than a judgement buried in a route
 * handler, which matters because the mistakes this file can make are the ones
 * that get worse over time rather than announcing themselves.
 */

/** The order placements are tried in when working out what taught a value. */
const PLACEMENTS: Placement[] = ['after', 'paragraph', 'below', 'column'];

/**
 * Which label on this page would have produced the value the operator typed.
 *
 * Run only for a field the reader left blank. Rather than matching the typed
 * value against the page — which cannot work, since the form holds a date as
 * `2026-11-03` where the page says `3 November 2026` — every plausible label is
 * tried through the field's own parser, and the one whose value comes out equal
 * is the one that was wanted.
 *
 * Returns null when nothing on the page produces it, which is the common and
 * correct answer: the operator knew something the sheet does not say.
 */
export function labelFor(
  text: string,
  field: ReadableField,
  wanted: string,
): FieldAlias | null {
  const lines = toLines(text);
  const parse = PARSERS[field];

  /*
   * If a label the dictionary already holds produces this value, there is
   * nothing to learn — and going looking anyway is how a coincidence gets
   * stored. Reached when a field was blank for some other reason, or when this
   * is called defensively.
   */
  for (const alias of BUILT_IN_ALIASES[field]) {
    const found = findBy(alias.placement, lines, alias.label, alias.lineStart ?? false);
    if (found.some((site) => parse(site.value) === wanted)) return null;
  }

  // Printed labels before bare column headings: a heading is recognised only
  // by its shape, so it is far likelier to be a value wearing a heading's
  // clothes. Tried at all because a columnar sheet has nothing else.
  const candidates = candidateLabels(text).sort(
    (left, right) => Number(right.strong) - Number(left.strong),
  );

  for (const candidate of candidates) {
    for (const placement of PLACEMENTS) {
      const found = findBy(placement, lines, candidate.label, candidate.lineStart);
      if (!found.some((site) => parse(site.value) === wanted)) continue;

      return {
        label: candidate.label,
        placement,
        ...(candidate.lineStart ? { lineStart: true } : {}),
      };
    }
  }

  return null;
}

/**
 * Every cell on the page that could be a label.
 *
 * Two shapes. A label with a colon or hash — `Uplift On:`, `Reservation#` —
 * which may share its cell with the value that follows it. And a bare column
 * heading, which must be a cell of its own, since a colonless word matched
 * inside a longer label reads a different field entirely.
 */
export function candidateLabels(
  text: string,
): Array<{ label: string; lineStart: boolean; strong: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; lineStart: boolean; strong: boolean }> = [];

  const add = (label: string, lineStart: boolean, strong: boolean) => {
    const key = `${label.toLowerCase()}|${lineStart}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, lineStart, strong });
  };

  for (const line of toLines(text)) {
    for (const cell of cellsOf(line)) {
      const labelled = /^([A-Za-z][A-Za-z0-9 .#/()'&+-]{0,30}[:#])(?:\s|$)/.exec(
        cell.text,
      );
      if (labelled) {
        // Short labels are only safe where a field would actually be printed,
        // so they are offered as line-start-only. `PU:` occurs inside plenty of
        // words.
        add(labelled[1]!, labelled[1]!.length <= 4, true);
        continue;
      }

      /*
       * A bare column heading. Nothing but its shape says it is one, so it is
       * taken only where it could not be a value: no digits, since a heading
       * counts nothing and a reference, a date and a postcode all carry them,
       * and few enough words to be a heading rather than a sentence.
       */
      if (
        /^[A-Za-z#][A-Za-z .#/()'&+-]{0,24}$/.test(cell.text) &&
        /[A-Za-z]{2}/.test(cell.text) &&
        cell.text.split(/\s+/).length <= 3
      ) {
        add(cell.text, false, false);
      }
    }
  }

  return out;
}

/**
 * How a field fared, once the operator has pressed Book.
 *
 * `kept` and `changed` both name the label that produced the value, so the
 * tallies land on the right row. `taught` is a label newly worked out for a
 * field that had none.
 */
export interface Lesson {
  kept: Array<{ field: ReadableField; source: FieldSource }>;
  changed: Array<{ field: ReadableField; source: FieldSource }>;
  taught: Array<{ field: ReadableField; alias: FieldAlias }>;
}

/**
 * Compare what was read against what was booked.
 *
 * `submitted` holds the form's own values, so the comparison is like for like:
 * both sides are the strings the form uses. A field absent from `submitted` is
 * one the form does not carry and is simply not judged.
 */
export function lessonFrom(
  text: string,
  draft: JobSheetDraft,
  sources: Partial<Record<ReadableField, FieldSource>>,
  submitted: Partial<Record<ReadableField, string>>,
): Lesson {
  const lesson: Lesson = { kept: [], changed: [], taught: [] };

  for (const field of Object.keys(BUILT_IN_ALIASES) as ReadableField[]) {
    const was = draft[field];
    const now = submitted[field];
    if (now === undefined) continue;

    const read = was ?? '';
    const booked = now.trim();

    if (read !== '' && booked === read) {
      const source = sources[field];
      if (source) lesson.kept.push({ field, source });
      continue;
    }

    if (read !== '' && booked !== read) {
      /*
       * A disagreement. Tallied against the label, never learned from — see
       * the note at the top. The operator may equally have been correcting the
       * agency.
       */
      const source = sources[field];
      if (source) lesson.changed.push({ field, source });
      continue;
    }

    // Nothing was read and something was typed: the gap worth learning from.
    if (read === '' && booked !== '') {
      const alias = labelFor(text, field, booked);
      if (alias) lesson.taught.push({ field, alias });
    }
  }

  return lesson;
}

/**
 * Whether a learned label still earns its place.
 *
 * One correction is not evidence — an operator also corrects a value the sheet
 * itself got wrong — so a label is only retired once it is being changed more
 * often than it is kept, and never on its first outing.
 */
export function stillTrusted(label: { confirmed: number; corrected: number }): boolean {
  if (label.corrected === 0) return true;
  if (label.confirmed + label.corrected < 3) return true;

  return label.confirmed > label.corrected;
}
