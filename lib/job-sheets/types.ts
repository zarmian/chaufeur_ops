/**
 * Reading an agency's job sheet.
 *
 * Partner agencies send bookings as a PDF — a one-page sheet with the date, the
 * passenger, two addresses and a reference — and somebody in the office retypes
 * it into the booking form. That retyping is the error: a transposed date puts a
 * car out on the wrong day, and nobody finds out until the client rings.
 *
 * Four decisions shape everything here.
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
 * the operator fills it in. Price is the standing temptation: agency sheets
 * routinely arrive with every charge line blank because the rate is agreed
 * afterwards, and a sheet with no price must produce a job with no price —
 * which the system already surfaces loudly — rather than a zero that reconciles
 * to nothing.
 *
 * **No agency is hardcoded.** Reading is driven by a dictionary of labels
 * (`./fields`), not by a template per sender, so a new agency whose sheet says
 * "Pick-up Date" works on the day it first arrives. Where a sender's wording is
 * unusual, the label is *learned* and stored rather than committed — see
 * `lib/job-sheets/store.ts`. This is why a second customer's agencies need no
 * code: the install learns them.
 */

/** One line of the sheet, as laid out on the page. */
export interface SheetLine {
  /** The text, with trailing space removed but leading space kept. */
  text: string;
  /** Characters of indentation, which is what makes the columns readable. */
  indent: number;
}

/** A cell of a line, and where along the line it starts. */
export interface SheetCell {
  text: string;
  start: number;
}

/**
 * Where a value sits relative to its label.
 *
 * Stored alongside a learned label, because the same wording is laid out
 * differently by different software and the placement is half of knowing where
 * to look.
 */
export type Placement =
  /** On the same line, to the right. `Pick-up Date:   14 Oct 2026` */
  | 'after'
  /** On the line below, in the label's own column. `Primary Passenger:` */
  | 'below'
  /** Under a column heading, a row or two down. `# of Pax` */
  | 'column'
  /** To the right and wrapping on, as an address or a note does. `PU:` */
  | 'paragraph';

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
  /** Lifted out of the address, because zone resolution prices on it. */
  pickupPostcode: string | null;
  dropoffText: string | null;
  dropoffPostcode: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  passengerCount: string | null;
  luggageCount: string | null;
  flightNumber: string | null;
  /**
   * The agency's own booking reference.
   *
   * Carried through to the job and onto the invoice line, because it is what
   * the agency's accounts department matches against. An invoice they cannot
   * reconcile is an invoice that is queried rather than paid.
   */
  customerReference: string | null;
  /** Pounds as typed into the form — `"125.50"`. Null when the sheet is silent. */
  clientPrice: string | null;
  /** What the sheet asked for — "V Class" — rather than one of our vehicles. */
  vehicleRequested: string | null;
  notes: string | null;
  /**
   * Inferred, not read: a sheet never names our own job types.
   *
   * It follows the flight and the addresses, and it is consequential enough to
   * be worth getting right — the free wait-time allowance is 45 minutes for an
   * airport arrival and 15 otherwise, and the flight number field does not even
   * appear on the form unless the job is an airport transfer.
   */
  jobType: string | null;
}

export const EMPTY_DRAFT: JobSheetDraft = {
  scheduledDate: null,
  scheduledTime: null,
  pickupText: null,
  pickupPostcode: null,
  dropoffText: null,
  dropoffPostcode: null,
  passengerName: null,
  passengerPhone: null,
  passengerCount: null,
  luggageCount: null,
  flightNumber: null,
  customerReference: null,
  clientPrice: null,
  vehicleRequested: null,
  notes: null,
  jobType: null,
};

/** The fields a label can point at. The rest are derived. */
export type ReadableField = Exclude<
  keyof JobSheetDraft,
  'jobType' | 'pickupPostcode' | 'dropoffPostcode'
>;

/** Where one value came from, so the operator can be told and a label learned. */
export interface FieldSource {
  label: string;
  placement: Placement;
}

export interface SheetRead {
  draft: JobSheetDraft;
  /**
   * What could not be read, in the operator's words.
   *
   * Said rather than left blank. A form that silently arrives without a time
   * looks like a sheet that had no time on it, and the operator fills in
   * something plausible instead of going to look.
   */
  missing: string[];
  /**
   * Which label produced each value.
   *
   * Shown to the operator, and kept on the stored sheet: when somebody corrects
   * a field, knowing which label got it wrong is what makes the correction
   * teachable rather than merely a fix to this one booking.
   */
  sources: Partial<Record<ReadableField, FieldSource>>;
}

/** The fields a booking cannot sensibly be taken without. */
export const REQUIRED: Array<{ key: keyof JobSheetDraft; said: string }> = [
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

/* ------------------------------------------------------------------ *
 * Cells
 *
 * A run of three or more spaces is a column break. An address never
 * contains one and every one of these layouts pads with many more, which
 * makes it the one reliable separator on a page whose columns are at
 * different offsets on every row.
 * ------------------------------------------------------------------ */

const COLUMN_GAP = / {3,}/;

/** The non-empty cells of a line, with where each begins. */
export function cellsOf(line: SheetLine): SheetCell[] {
  const cells: SheetCell[] = [];
  let cursor = 0;

  for (const piece of line.text.split(COLUMN_GAP)) {
    const start = line.text.indexOf(piece, cursor);
    const at = start === -1 ? cursor : start;
    const text = piece.trim();

    if (text !== '') {
      cells.push({ text, start: at + (piece.length - piece.trimStart().length) });
    }
    cursor = at + piece.length;
  }

  return cells;
}

/**
 * The cell beginning nearest a given column, if one is near enough.
 *
 * This is what keeps a wrapped address in its own column. The second line of a
 * destination shares its row with the first charge line, and without this the
 * address comes out as "…SW7 2AP Service Charge Parking Tolls VAT".
 */
export function cellNear(
  line: SheetLine,
  column: number,
  slack = 12,
): string | null {
  let best: SheetCell | null = null;

  for (const cell of cellsOf(line)) {
    const distance = Math.abs(cell.start - column);
    if (distance > slack) continue;
    if (!best || distance < Math.abs(best.start - column)) best = cell;
  }

  return best?.text ?? null;
}

/** The left-hand cell of a line, discarding any column beside it. */
export function firstCell(text: string): string {
  return text.split(COLUMN_GAP)[0]!.trim();
}

/** Collapse the whitespace a two-column layout leaves inside a joined line. */
export function tidyRun(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A cell that is only a label — `Booked On:` — and so is not a value.
 *
 * The check that stops the field to the right of a label being read as its
 * value. On the sample sheet `Primary Passenger:` and `Booked On:` sit on the
 * same line, and reading rightwards from the first gives the second's name.
 */
export function looksLikeLabel(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9 .#/()'&+-]{0,30}[:#]$/.test(value.trim());
}

/**
 * A cell that is a label *with* its own value — `Our Ref #: 30700`.
 *
 * Which makes it the next field rather than a continuation of this one, or a
 * value belonging to the label above. Without this check, a `Pick-up` heading
 * whose box was blank reads two lines down and offers up
 * "Passenger Name: Dilara Koc" as the pickup address: a plausible-looking
 * booking a driver would be sent to a street that does not exist.
 */
export function carriesLabel(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9 .#/()'&+-]{0,24}[:#]\s+\S/.test(value.trim());
}

/** The cell a position on a line falls inside. */
function cellHolding(line: SheetLine, at: number): SheetCell | null {
  let holding: SheetCell | null = null;

  for (const cell of cellsOf(line)) {
    if (cell.start <= at) holding = cell;
  }

  return holding;
}

/* ------------------------------------------------------------------ *
 * Finding a labelled value
 * ------------------------------------------------------------------ */

interface Found {
  value: string;
  /** Where the label itself began, which is the column a value wraps in. */
  column: number;
}

/**
 * Every place a label appears, in reading order.
 *
 * Plural because a word like `Date:` occurs several times on a page and only
 * one of them has the value. The caller tries each until a parser accepts one,
 * which is how a blank box falls through to the next candidate rather than
 * ending the search.
 */
function labelSites(
  lines: SheetLine[],
  label: string,
  lineStart: boolean,
): Array<{ index: number; at: number }> {
  const needle = label.toLowerCase();
  const sites: Array<{ index: number; at: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const haystack = lines[index]!.text.toLowerCase();
    let at = haystack.indexOf(needle);

    while (at !== -1) {
      /*
       * `lineStart` is what makes short labels usable at all. `PU:`, `To:` and
       * `From:` are common enough to be worth reading and short enough to
       * occur inside other words and other columns, so they are only honoured
       * where a field would actually be printed: at the start of a line, or at
       * the start of its own cell.
       */
      const ownCell = at === lines[index]!.indent || /\s{3}$/.test(
        lines[index]!.text.slice(0, at),
      );

      /*
       * A label with no colon or hash after it — a column heading like
       * `# of Pax`, or a bare `Pick-up` — must fill its cell exactly.
       *
       * Otherwise it matches inside a longer label and reads a different
       * field's value: `Pick-up` is a substring of `Pick-up Date:`, and the
       * line below *that* is whatever field comes next. A label that does end
       * in a colon is free to sit inside a cell, because its value is what
       * follows it there.
       */
      const whole =
        /[:#]$/.test(label) ||
        cellHolding(lines[index]!, at)?.text.toLowerCase() === needle;

      if ((!lineStart || ownCell) && whole) sites.push({ index, at });

      at = haystack.indexOf(needle, at + 1);
    }
  }

  return sites;
}

/**
 * The first non-empty cell of what remains of a line after a position.
 *
 * Cut from the position rather than picked out of the line's own cells,
 * because a label and its value usually share a cell — `PU: The Westin…`,
 * `Mb: +1 615…` — and looking for a cell that *starts* after the label skips
 * the value and lands on the next column along.
 */
function cellAfter(line: SheetLine, from: number): string | null {
  for (const piece of line.text.slice(from).split(COLUMN_GAP)) {
    const text = piece.trim();
    if (text !== '') return text;
  }
  return null;
}

/**
 * The value to the right of a label on the same line.
 *
 * `Pick-up Date:        14 Oct 2026` gives `14 Oct 2026`. A value that is
 * itself only a label is refused, because that means the box was blank and the
 * next column along has been reached.
 */
export function valueAfter(
  lines: SheetLine[],
  label: string,
  options: { lineStart?: boolean } = {},
): Found[] {
  const out: Found[] = [];

  for (const site of labelSites(lines, label, options.lineStart ?? false)) {
    const line = lines[site.index]!;
    const value = cellAfter(line, site.at + label.length);

    if (value && !looksLikeLabel(value)) {
      out.push({ value, column: site.at });
    }
  }

  return out;
}

/**
 * The value on the line *below* a label, which is how a name is often set out.
 *
 * `Primary Passenger:` sits above `Teresa Vaughan` rather than beside it.
 * Matched on the label's own column so a value belonging to a different field
 * is not picked up: the line below may carry three of them.
 */
export function valueBelow(
  lines: SheetLine[],
  label: string,
  options: { lineStart?: boolean; within?: number } = {},
): Found[] {
  const out: Found[] = [];
  const slack = options.within ?? 4;

  for (const site of labelSites(lines, label, options.lineStart ?? false)) {
    for (
      let below = site.index + 1;
      below < lines.length && below <= site.index + 2;
      below += 1
    ) {
      const value = cellNear(lines[below]!, site.at, slack);
      if (value && !looksLikeLabel(value) && !carriesLabel(value)) {
        out.push({ value, column: site.at });
        break;
      }
    }
  }

  return out;
}

/**
 * A value sitting under a column heading, a row or two down.
 *
 * Wider slack than `below`, because a value is rarely flush with its heading —
 * `5` sits under the middle of `# of Pax` — and a rule or a blank row often
 * comes between. The caller's parser is what stops the neighbouring column
 * answering: `# of Pax` and `Vehicle Type` share a row of values, and without
 * a shape check the passenger count comes back as "V Class".
 */
export function valueUnder(
  lines: SheetLine[],
  label: string,
  options: { lineStart?: boolean } = {},
): Found[] {
  const out: Found[] = [];

  for (const site of labelSites(lines, label, options.lineStart ?? false)) {
    const slack = Math.ceil(label.length / 2) + 3;

    for (
      let below = site.index + 1;
      below < lines.length && below <= site.index + 4;
      below += 1
    ) {
      const value = cellNear(lines[below]!, site.at, slack);
      if (value && !looksLikeLabel(value) && !carriesLabel(value)) {
        out.push({ value, column: site.at });
      }
    }
  }

  return out;
}

/**
 * Everything after a label, running on until the text stops.
 *
 * Addresses and notes wrap, and the continuation carries no label of its own:
 * `PU: -- : The Westin London City, 60 Upper Thames Street,` is followed by
 * `London,, EC4V 3AD`. Each continuation is taken from the label's own column,
 * so the charges printed alongside stay out of the address, and the run ends at
 * a blank line, at the next label, or at the agency's standing instructions.
 */
export function paragraphAfter(
  lines: SheetLine[],
  label: string,
  options: { lineStart?: boolean } = {},
): Found[] {
  const out: Found[] = [];

  for (const site of labelSites(lines, label, options.lineStart ?? false)) {
    const line = lines[site.index]!;
    const parts: string[] = [];

    const first = cellAfter(line, site.at + label.length);
    if (first && !looksLikeLabel(first)) parts.push(first);

    for (let next = site.index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (candidate.text.trim() === '') break;
      if (/IMPORTANT INSTRUCTIONS/i.test(candidate.text)) break;

      const cell = cellNear(candidate, site.at);
      if (!cell || looksLikeLabel(cell)) break;
      // A cell that is a label *with* a value — "Our Ref #: 30700" — is the
      // next field, not more of this one.
      if (carriesLabel(cell)) break;

      parts.push(cell);
    }

    const joined = tidyRun(parts.join(' '));
    if (joined !== '') out.push({ value: joined, column: site.at });
  }

  return out;
}

/** Run a placement by name. */
export function findBy(
  placement: Placement,
  lines: SheetLine[],
  label: string,
  lineStart: boolean,
): Found[] {
  switch (placement) {
    case 'after':
      return valueAfter(lines, label, { lineStart });
    case 'below':
      return valueBelow(lines, label, { lineStart });
    case 'column':
      return valueUnder(lines, label, { lineStart });
    case 'paragraph':
      return paragraphAfter(lines, label, { lineStart });
  }
}
