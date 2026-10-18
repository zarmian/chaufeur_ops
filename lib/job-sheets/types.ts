/**
 * Reading an agency's job sheet.
 *
 * Partner agencies send bookings as a PDF — a one-page sheet with the date, the
 * passenger, two addresses and a reference — and somebody in the office retypes
 * it into the booking form. That retyping is the error: a transposed date puts a
 * car out on the wrong day, and nobody finds out until the client rings.
 *
 * Three decisions shape everything here.
 *
 * **The output is form values, not a job.** Nothing in this directory writes to
 * the database, allocates a reference, or converts money or dates into their
 * stored forms. It produces exactly what `JobForm` already takes as `values`,
 * which means the operator sees the sheet as a filled-in booking form and
 * presses Book — through the same validation, compliance checks, pricing and
 * clash warnings as anything typed by hand. There is no second way to create a
 * job to keep in step with the first.
 *
 * **A sheet is read, never obeyed.** These documents are full of imperative
 * prose — how to dress, how long to wait, who to ring. It is text about driver
 * conduct, and it is extracted as notes or ignored. Deterministic extraction is
 * partly chosen for that reason: a model reading a supplier's PDF is a model
 * taking instructions from whoever can email one.
 *
 * **Nothing is invented.** A field the sheet does not carry comes back null and
 * the operator fills it in. The temptation worth naming is price: this sample
 * arrives with every charge line blank, and a sheet with no price must produce
 * a job with no price — which the system already surfaces loudly — rather than
 * a zero that reconciles to nothing.
 */

/** One line of the sheet, as laid out on the page. */
export interface SheetLine {
  /** The text, with trailing space removed but leading space kept. */
  text: string;
  /** Characters of indentation, which is what makes the columns readable. */
  indent: number;
}

/**
 * What a sheet yielded, in the booking form's own terms.
 *
 * Every field is optional because every field can be missing from a real sheet,
 * and a half-read sheet that pre-fills six fields correctly is worth far more
 * than one that refuses because it could not find the seventh.
 */
export interface JobSheetDraft {
  /** `YYYY-MM-DD`, in the operator's own calendar. */
  scheduledDate: string | null;
  /** `HH:mm`, 24-hour. */
  scheduledTime: string | null;
  pickupText: string | null;
  dropoffText: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  passengerCount: string | null;
  luggageCount: string | null;
  flightNumber: string | null;
  /** The agency's own booking reference, kept so the two systems can be tied. */
  theirReference: string | null;
  /** Pounds as typed into the form — `"125.50"`. Null when the sheet is silent. */
  clientPrice: string | null;
  /** What the sheet asked for — "V Class" — rather than one of our vehicles. */
  vehicleRequested: string | null;
  notes: string | null;
}

export const EMPTY_DRAFT: JobSheetDraft = {
  scheduledDate: null,
  scheduledTime: null,
  pickupText: null,
  dropoffText: null,
  passengerName: null,
  passengerPhone: null,
  passengerCount: null,
  luggageCount: null,
  flightNumber: null,
  theirReference: null,
  clientPrice: null,
  vehicleRequested: null,
  notes: null,
};

export interface JobSheetTemplate {
  /** Stable id, stored on the sheet so a reread uses the same reader. */
  name: string;
  /** Shown to the operator: "Montclares International". */
  label: string;
  /** Whether this template recognises the sheet. */
  matches: (lines: SheetLine[]) => boolean;
  read: (lines: SheetLine[]) => JobSheetDraft;
}

export interface SheetRead {
  template: JobSheetTemplate | null;
  draft: JobSheetDraft;
  /**
   * What could not be read, in the operator's words.
   *
   * Said rather than left blank. A form that silently arrives without a time
   * looks like a sheet that had no time on it, and the operator fills in
   * something plausible instead of going to look.
   */
  missing: string[];
}

/** The fields a booking cannot sensibly be taken without. */
const REQUIRED: Array<{ key: keyof JobSheetDraft; said: string }> = [
  { key: 'scheduledDate', said: 'the pickup date' },
  { key: 'scheduledTime', said: 'the pickup time' },
  { key: 'pickupText', said: 'the pickup address' },
  { key: 'dropoffText', said: 'the destination' },
];

/**
 * Split extracted text into lines, keeping the indentation.
 *
 * The indentation is not decoration: these sheets lay their values out in
 * columns, and the only thing tying `5` to `# of Pax` rather than to
 * `Vehicle Type` is how far along the line it starts.
 */
export function toLines(text: string): SheetLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const trimmedEnd = raw.replace(/\s+$/, '');
    return {
      text: trimmedEnd,
      indent: trimmedEnd.length - trimmedEnd.trimStart().length,
    };
  });
}

/**
 * Read a sheet with whichever template recognises it.
 *
 * An unrecognised sheet comes back with an empty draft and everything listed as
 * missing, rather than with a guess. A template matched on the wrong agency
 * would read its columns in the wrong places and produce a draft that looks
 * filled in and is wrong, which is worse than an empty form.
 */
export function readSheet(
  text: string,
  templates: JobSheetTemplate[],
): SheetRead {
  const lines = toLines(text);
  const template = templates.find((candidate) => candidate.matches(lines)) ?? null;
  const draft = template ? template.read(lines) : { ...EMPTY_DRAFT };

  const missing = REQUIRED.filter(({ key }) => draft[key] === null).map(
    ({ said }) => said,
  );

  return { template, draft, missing };
}

/* ------------------------------------------------------------------ *
 * Shared readers
 *
 * Every agency lays a sheet out differently, but they all lay it out as
 * labels and values, so the finding is shared and only the labels differ.
 * ------------------------------------------------------------------ */

/**
 * The value to the right of a label on the same line.
 *
 * `Pick-up Date:        14 Oct 2026` gives `14 Oct 2026`. Returns null when the
 * label is there with nothing after it, which on these sheets means a field the
 * agency left blank rather than one this failed to read.
 */
export function valueAfter(lines: SheetLine[], label: string): string | null {
  const needle = label.toLowerCase();

  for (const line of lines) {
    const at = line.text.toLowerCase().indexOf(needle);
    if (at === -1) continue;

    const rest = line.text.slice(at + label.length).trim();
    if (rest !== '') return rest;
  }
  return null;
}

/**
 * The value on the line *below* a label, which is how a name is often set out.
 *
 * `Primary Passenger:` sits above `Shawna Rayford` rather than beside it.
 * Matched on the label's own indentation so a value belonging to a different
 * column is not picked up: the line below may carry three fields.
 */
export function valueBelow(
  lines: SheetLine[],
  label: string,
  options: { within?: number } = {},
): string | null {
  const needle = label.toLowerCase();
  const slack = options.within ?? 3;

  for (let index = 0; index < lines.length; index += 1) {
    const at = lines[index]!.text.toLowerCase().indexOf(needle);
    if (at === -1) continue;

    for (let below = index + 1; below < lines.length && below <= index + 2; below += 1) {
      const candidate = columnAt(lines[below]!, at, slack);
      if (candidate) return candidate;
    }
  }
  return null;
}

/**
 * The word starting at roughly a given column.
 *
 * Roughly, because a value is rarely flush with its heading — `5` sits under
 * the middle of `# of Pax`. The slack is what makes a column readable at all,
 * and it is small enough not to reach the next one.
 */
export function columnAt(
  line: SheetLine,
  column: number,
  slack = 3,
): string | null {
  if (line.text.trim() === '') return null;

  for (const match of line.text.matchAll(/\S[^\s]*(?:[ ]\S+)*/g)) {
    const start = match.index ?? 0;
    if (Math.abs(start - column) <= slack) {
      const value = match[0].trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * Everything after a label, running on until the text stops.
 *
 * Addresses and notes wrap, and the continuation carries no label of its own:
 * `PU: -- : The Westin London City, 60 Upper Thames Street,` is followed by
 * `London,, EC4V 3AD`. Stops at a blank line or at anything that looks like the
 * next field, because running on would paste the whole right-hand column into
 * an address.
 */
export function paragraphAfter(
  lines: SheetLine[],
  label: string,
  options: { stopAt?: RegExp } = {},
): string | null {
  const needle = label.toLowerCase();
  const stop = options.stopAt ?? /^\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const at = lines[index]!.text.toLowerCase().indexOf(needle);
    if (at === -1) continue;

    const parts: string[] = [];
    const first = firstCell(lines[index]!.text.slice(at + label.length));
    if (first !== '') parts.push(first);

    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!.text;
      if (line.trim() === '' || stop.test(line)) break;

      const cell = firstCell(line);
      if (cell === '') break;
      parts.push(cell);
    }

    const joined = tidyRun(parts.join(' '));
    return joined === '' ? null : joined;
  }
  return null;
}

/** Collapse the whitespace a two-column layout leaves inside a joined line. */
export function tidyRun(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The left-hand cell of a line, discarding any column beside it.
 *
 * These sheets are two columns wide and the extractor sees them as one line:
 * the second line of a destination address shares its row with the first
 * charge line, so a destination read to the end of the line comes out as
 * "…SW7 2AP Service Charge". A run of three or more spaces is a column break —
 * an address never contains one, and every one of these layouts pads with
 * many more than three.
 */
export function firstCell(text: string): string {
  return text.split(/ {3,}/)[0]!.trim();
}
