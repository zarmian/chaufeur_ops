import { tidyRun } from './types';

/**
 * Turning what a sheet says into what a form field takes.
 *
 * Every parser here returns null rather than its best guess. That is the whole
 * character of this file: a field left blank is a field the operator fills in,
 * which costs ten seconds, where a field filled in wrongly is a car in the
 * wrong place on the wrong day and nobody looking for it, because the form
 * looked complete.
 */

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
 * than guessed at. A month written in words is the one form that cannot be
 * read two ways, and it is what agency software overwhelmingly prints.
 */
export function parseSheetDate(value: string | null): string | null {
  if (!value) return null;

  const match =
    /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})\b/.exec(value) ??
    // "Oct 14 2026", which US-configured software prints.
    /\b([A-Za-z]{3,})[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})\b/.exec(value);
  if (!match) return null;

  // The two orders put the day and the month in different capture slots.
  const dayFirst = /^\d/.test(match[1]!);
  const day = dayFirst ? match[1]! : match[2]!;
  const monthWord = dayFirst ? match[2]! : match[1]!;
  const year = match[3]!;

  const month = MONTHS[monthWord.slice(0, 3).toLowerCase()];
  if (!month) return null;

  const iso = `${year}-${month}-${day.padStart(2, '0')}`;

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

  const meridiem = /\b(\d{1,2})[:.](\d{2})\s*([AP])\.?M\.?\b/i.exec(value);
  if (meridiem) {
    const [, rawHour, minute, half] = meridiem as unknown as [
      string, string, string, string,
    ];
    let hour = Number(rawHour);
    if (hour < 1 || hour > 12 || Number(minute) > 59) return null;

    const pm = half.toUpperCase() === 'P';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;

    return `${String(hour).padStart(2, '0')}:${minute}`;
  }

  const plain = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(value);
  if (!plain) return null;

  return `${plain[1]!.padStart(2, '0')}:${plain[2]}`;
}

/**
 * `£1,250.50`, `1250.50`, `1,250` to the string the form wants.
 *
 * Returns null for a blank, a dash or a zero. A sheet that names no price must
 * produce a job with no price: the system surfaces an unpriced job everywhere
 * on purpose, where a silent zero reconciles to nothing and is invisible until
 * the month is short. Agency sheets frequently arrive with every charge line
 * blank — the price is agreed afterwards — so this is the normal case, not the
 * exceptional one.
 */
export function parseSheetMoney(value: string | null): string | null {
  if (!value) return null;

  const match = /(\d[\d,]*)(?:\.(\d{1,2}))?/.exec(value.replace(/\s/g, ''));
  if (!match) return null;

  const whole = match[1]!.replace(/,/g, '');
  const pence = (match[2] ?? '').padEnd(2, '0');
  if (whole === '' || (/^0+$/.test(whole) && (pence === '00' || pence === ''))) {
    return null;
  }

  return `${whole}.${pence || '00'}`;
}

/**
 * A phone number, kept in the form the sheet wrote it.
 *
 * Not normalised to E.164 here. The passenger's number on these sheets is
 * frequently foreign — this sample's is American — and `lib/sms.ts` already
 * owns the one normalisation that has to be right, at the point where a
 * message is actually sent. Rewriting it twice in two places is how the two
 * come to disagree.
 */
export function parseSheetPhone(value: string | null): string | null {
  if (!value) return null;

  const match = /\+?\d[\d\s()./-]{6,}\d/.exec(value);
  if (!match) return null;

  const number = tidyRun(match[0]);
  // Eight digits is a short landline; fewer is a reference that happens to
  // have punctuation in it.
  const digits = number.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;

  return number;
}

/** A small whole number — a passenger or luggage count. */
export function parseSheetCount(value: string | null): string | null {
  if (!value) return null;

  const match = /^\s*(\d{1,2})\b/.exec(value);
  if (!match) return null;

  const count = Number(match[1]);
  if (count === 0) return null;

  return String(count);
}

/** A reference, as printed. Letters, digits and the punctuation refs contain. */
export function parseSheetReference(value: string | null): string | null {
  if (!value) return null;

  const match = /[A-Za-z0-9][A-Za-z0-9/_-]{1,31}/.exec(value.trim());
  if (!match) return null;

  return match[0];
}

/** Strip the `-- :` placeholder and the comma soup a wrapped address leaves. */
export function cleanAddress(value: string | null): string | null {
  if (!value) return null;

  const cleaned = tidyRun(
    value
      .replace(/^-+\s*:\s*/, '')
      .replace(/\s*,\s*,\s*/g, ', ')
      .replace(/\s+,/g, ','),
  )
    .replace(/[,\s]+$/, '');

  return cleaned === '' ? null : cleaned;
}

/**
 * A postcode, if the address ends in one.
 *
 * Worth lifting out separately because the job carries it in its own column:
 * zone resolution reads it, which is what prices the job. An address typed as
 * free text still has to price correctly.
 */
export function postcodeOf(address: string | null): string | null {
  if (!address) return null;

  // The last one, because a postcode comes at the end of an address and a
  // building's name can contain something postcode-shaped: "Studio W1, 2 Bank
  // Street" would otherwise answer before the real one.
  const matches = [
    ...address.matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/gi),
  ];
  const match = matches.at(-1);
  if (!match) return null;

  return `${match[1]!.toUpperCase()} ${match[2]!.toUpperCase()}`;
}

/**
 * Tidy a note, dropping a phone number the sheet has already given as a field.
 *
 * A note that repeats a field is a note nobody reads twice, and these sheets
 * habitually write the passenger's mobile into the notes as well as into its
 * own box.
 */
export function cleanNotes(value: string | null): string | null {
  if (!value) return null;

  const cleaned = tidyRun(
    value
      .replace(/^(?:cell|mob(?:ile)?|tel|phone)\s*:?\s*[\d\s()+./-]{7,}/i, '')
      .replace(/^[-–:,\s]+/, ''),
  );

  return cleaned === '' ? null : cleaned;
}
