import {
  columnAt,
  EMPTY_DRAFT,
  paragraphAfter,
  tidyRun,
  valueAfter,
  valueBelow,
  type JobSheetDraft,
  type JobSheetTemplate,
  type SheetLine,
} from './types';

/**
 * Montclares International's job sheet.
 *
 * The first template, and the shape of the ones after it: a `matches` that is
 * specific enough not to fire on another agency's paperwork, and a `read` that
 * says where each field lives on *this* page and nowhere else.
 *
 * What the sheet actually gives, from the sample:
 *
 *     Pick-up Date:                 14 Oct 2026
 *     Pick-up Time:                 03:00 PM
 *     Reservation#                  30700
 *     Primary Passenger:
 *     Shawna Rayford
 *     Hm: Mb: +1 615-635-7516
 *     # of Pax      Vehicle Type
 *         5           V Class
 *     PU: -- : The Westin London City, 60 Upper Thames Street,
 *     London,, EC4V 3AD
 *     DO: -- : Royal Albert hall Kensington Gore, South Kensington
 *     London, SW7 2AP
 *     Trip Notes: cell: … MUST BE FULL SIZED SUV …
 *
 * And what it does not give, which matters as much: every charge line —
 * Service Charge, Parking, Tolls, VAT, Trip Total — is blank. So is the
 * vehicle registration and the driver. This reads the sheet it was given
 * rather than the sheet it would like.
 */

/**
 * Two marks rather than one.
 *
 * The trading name alone would match any email signature that mentioned them;
 * the labels alone would match half the agencies in London. Together they are
 * this template. Matching the wrong agency is the failure worth paying for:
 * it would read another sheet's columns in these positions and produce a
 * booking that looks filled in and is wrong.
 */
function matches(lines: SheetLine[]): boolean {
  const text = lines
    .map((line) => line.text)
    .join('\n')
    .toLowerCase();

  return (
    text.includes('montclares') &&
    text.includes('pick-up date') &&
    (text.includes('reservation#') || text.includes('our ref'))
  );
}

function read(lines: SheetLine[]): JobSheetDraft {
  const date = parseSheetDate(valueAfter(lines, 'Pick-up Date:'));
  const time = parseSheetTime(valueAfter(lines, 'Pick-up Time:'));

  return {
    ...EMPTY_DRAFT,
    scheduledDate: date,
    scheduledTime: time,

    /*
     * `PU:` and `DO:` carry a `-- :` marker before the address — a slot for a
     * terminal or a flight on an airport job, empty here. Stripped, because a
     * booking form showing "-- : The Westin" is a booking form somebody has to
     * tidy before they can read it.
     */
    pickupText: cleanAddress(
      paragraphAfter(lines, 'PU:', { stopAt: /^\s*(DO:|Addtl|Charges)/i }),
    ),
    dropoffText: cleanAddress(
      paragraphAfter(lines, 'DO:', { stopAt: /^\s*(PU:|Service Charge|Charges)/i }),
    ),

    // The name sits under its label rather than beside it.
    passengerName: valueBelow(lines, 'Primary Passenger:'),
    passengerPhone: parseSheetPhone(lines),
    passengerCount: underHeading(lines, '# of Pax', /^\d{1,2}$/),
    vehicleRequested: underHeading(lines, 'Vehicle Type', /^[A-Za-z]/),

    theirReference: valueAfter(lines, 'Reservation#') ?? valueAfter(lines, 'Our Ref #:'),
    clientPrice: parseSheetMoney(valueAfter(lines, 'Trip Total')),
    notes: readNotes(lines),
  };
}

export const montclares: JobSheetTemplate = {
  name: 'montclares',
  label: 'Montclares International',
  matches,
  read,
};

/* ------------------------------------------------------------------ *
 * The parsers
 * ------------------------------------------------------------------ */

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * `14 Oct 2026` to `2026-10-14`.
 *
 * Deliberately narrow. A sheet saying `10/14/2026` and one saying `14/10/2026`
 * are indistinguishable without knowing which side of the Atlantic wrote it,
 * and a booking a month out from where it should be is worse than a blank
 * field somebody has to fill in — so an all-numeric date is refused rather
 * than guessed at. This agency writes the month in words, which is the one
 * form that cannot be read two ways.
 */
export function parseSheetDate(value: string | null): string | null {
  if (!value) return null;

  const match = /\b(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\b/.exec(value);
  if (!match) return null;

  const [, day, monthWord, year] = match as unknown as [string, string, string, string];
  const month = MONTHS[monthWord.slice(0, 3).toLowerCase()];
  if (!month) return null;

  const padded = day.padStart(2, '0');
  const iso = `${year}-${month}-${padded}`;

  // A real calendar day, so `31 Feb` is refused rather than rolled forward
  // into March by a Date constructor being helpful.
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCDate() !== Number(day)) return null;

  return iso;
}

/**
 * `03:00 PM` to `15:00`.
 *
 * Midnight and noon are the two that catch everybody: `12:00 AM` is `00:00`
 * and `12:00 PM` is `12:00`, and the arithmetic that gets one right usually
 * gets the other wrong. A sheet already in 24-hour form is taken as it is.
 */
export function parseSheetTime(value: string | null): string | null {
  if (!value) return null;

  const meridiem = /\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(value);
  if (meridiem) {
    const [, rawHour, minute, suffix] = meridiem as unknown as [
      string, string, string, string,
    ];
    let hour = Number(rawHour);
    if (hour < 1 || hour > 12 || Number(minute) > 59) return null;

    const pm = suffix.toUpperCase() === 'PM';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;

    return `${String(hour).padStart(2, '0')}:${minute}`;
  }

  const plain = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(value);
  if (!plain) return null;

  return `${plain[1]!.padStart(2, '0')}:${plain[2]}`;
}

/**
 * `£1,250.50`, `1250.50`, `1,250` to the string the form wants.
 *
 * Returns null for a blank, a dash or a zero — which is the case this sample
 * is in. A sheet that names no price must produce a job with no price: the
 * system surfaces an unpriced job everywhere on purpose, where a silent zero
 * reconciles to nothing and is invisible until the month is short.
 */
export function parseSheetMoney(value: string | null): string | null {
  if (!value) return null;

  const match = /(\d[\d,]*)(?:\.(\d{1,2}))?/.exec(value.replace(/\s/g, ''));
  if (!match) return null;

  const whole = match[1]!.replace(/,/g, '');
  const pence = (match[2] ?? '').padEnd(2, '0');
  if (whole === '' || /^0+$/.test(whole) && (pence === '00' || pence === '')) {
    return null;
  }

  return `${whole}.${pence || '00'}`;
}

/**
 * The passenger's mobile, from a line that offers two slots and fills one.
 *
 * The sheet writes `Hm: Mb: +1 615-635-7516` — home then mobile, with the
 * home number simply absent. Taking "the number on the line" would be right
 * here and wrong the moment a sheet carries both.
 */
export function parseSheetPhone(lines: SheetLine[]): string | null {
  for (const line of lines) {
    if (!/\bMb:/i.test(line.text)) continue;

    const after = line.text.slice(line.text.search(/\bMb:/i) + 3);
    const number = /\+?[\d][\d\s()-]{6,}/.exec(after);
    if (number) return tidyRun(number[0]);
  }
  return null;
}

/**
 * A value sitting under a column heading.
 *
 * The heading's own offset is where to look, and the pattern is what stops a
 * neighbouring column answering: `# of Pax` and `Vehicle Type` share a row of
 * values, and without the shape check the passenger count could come back as
 * "V Class".
 */
function underHeading(
  lines: SheetLine[],
  heading: string,
  shape: RegExp,
): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const at = lines[index]!.text.indexOf(heading);
    if (at === -1) continue;

    // Values can sit a line or two below the heading, with a rule between.
    for (let below = index + 1; below <= index + 4 && below < lines.length; below += 1) {
      const value = columnAt(lines[below]!, at, Math.ceil(heading.length / 2) + 2);
      if (value && shape.test(value)) return value;
    }
  }
  return null;
}

/**
 * The trip notes, and only the trip notes.
 *
 * Everything below them on this sheet is the agency's standing instructions to
 * drivers — how to dress, how long to wait, who to ring — which is the same on
 * every sheet they send and belongs in a contract rather than on a job. Pulling
 * it through would bury the one line that is actually about this booking.
 */
function readNotes(lines: SheetLine[]): string | null {
  const notes = paragraphAfter(lines, 'Trip Notes:', {
    stopAt: /IMPORTANT INSTRUCTIONS|^\s*Signature:/i,
  });
  if (!notes) return null;

  // The sheet repeats the passenger's mobile into the notes. Harmless, but it
  // is already a field, and a note that duplicates a field is a note nobody
  // reads twice.
  return tidyRun(notes.replace(/^cell:\s*[\d\s()+-]+/i, '')) || null;
}

/** Strip the `-- :` placeholder and the comma soup a wrapped address leaves. */
function cleanAddress(value: string | null): string | null {
  if (!value) return null;

  const cleaned = tidyRun(
    value
      .replace(/^-+\s*:\s*/, '')
      .replace(/\s*,\s*,\s*/g, ', ')
      .replace(/\s+,/g, ','),
  );

  return cleaned === '' ? null : cleaned;
}
