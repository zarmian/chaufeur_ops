/**
 * Finding a flight number, and not finding one that is not there.
 *
 * This is the field where a confident wrong answer does the most damage,
 * because a flight number does not just sit on the job: `lib/flights` looks it
 * up, moves the pickup to the arrival time, and tells the dispatch board it
 * did. A wrong code either fails to resolve — noise — or resolves to a real
 * aeroplane landing at a different hour, and the pickup walks away from the
 * passenger on its own.
 *
 * The difficulty is that a flight number has no distinctive shape in Britain.
 * `BA117` is two letters and three digits. So is `RM13 9XJ`'s outward code
 * with its postcode stripped, and so is half of every registration plate. The
 * sample sheet that prompted this carries `RM13 9XJ`, `EC4V 3AD`, `SW7 2AP`
 * and a reservation number — four things a shape test alone would offer up as
 * flights.
 *
 * So the rule is: **a flight is only ever read from somewhere that says
 * flight.** Either a labelled field, or the word itself in prose next to a
 * code. Never a bare token that merely looks like one. The sheet is also full
 * of the word in standing instructions — "drivers must be on location at
 * flight landing time" — which is why the prose search demands a code
 * immediately after it and finds nothing there.
 */

/**
 * An airline designator and a number.
 *
 * Two letters (`BA`), a letter and a digit (`U2`, `4U`), or three letters for
 * the ICAO form some sheets print (`BAW`). One to four digits, and the
 * trailing letter a handful of carriers use on a leg.
 */
const FLIGHT_SHAPE = /^(?:[A-Z]{2,3}|[A-Z]\d|\d[A-Z])[\s-]?\d{1,4}[A-Z]?$/;

/** The inward half of a UK postcode: `9XJ`. Never part of a flight number. */
const POSTCODE_TAIL = /^\d[A-Z]{2}$/;

/**
 * Read a value that was labelled as a flight.
 *
 * Still checked against the shape, because these boxes get "TBC", "N/A", a
 * dash, or an airline's name with no number — and `N/A` stored as a flight
 * number is a tracking lookup that fails every few minutes for the life of the
 * job.
 */
export function parseFlightNumber(value: string | null): string | null {
  if (!value) return null;

  const candidate = value.trim().toUpperCase();

  // Take the first token only: "BA117 LANDS 14:35" is a flight number and a
  // piece of commentary.
  const first = /^[A-Z0-9]+(?:[\s-][0-9][0-9A-Z]*)?/.exec(candidate)?.[0] ?? '';
  const tidy = first.replace(/[\s-]/g, '');

  if (!FLIGHT_SHAPE.test(first.replace(/\s+/g, ' '))) return null;
  // A flight number has at least one digit and at least one letter; `30700`
  // and `ABCD` are each something else.
  if (!/\d/.test(tidy) || !/[A-Z]/.test(tidy)) return null;

  return tidy;
}

/**
 * Find a flight in free text, where the word itself vouches for the code.
 *
 * Agency sheets habitually bury it in the notes — "arriving on BA117, flight
 * lands 14:35" — rather than giving it a box, which on a sheet with no flight
 * field is the only place it exists.
 */
export function findFlightInText(text: string): string | null {
  const pattern =
    /\bflight\s*(?:no\.?|number|num|#)?\s*[:\-]?\s*([A-Z]{2,3}|[A-Z]\d|\d[A-Z])[\s-]?(\d{1,4}[A-Z]?)\b/gi;

  for (const match of text.matchAll(pattern)) {
    const found = parseFlightNumber(`${match[1]}${match[2]}`);
    if (found) return found;
  }

  // The other way round: "on BA117 flight", "BA117 arriving".
  const trailing =
    /\b([A-Z]{2,3}|[A-Z]\d|\d[A-Z])[\s-]?(\d{1,4}[A-Z]?)\s+(?:flight|arriv|inbound|lands|landing)/gi;

  for (const match of text.matchAll(trailing)) {
    if (POSTCODE_TAIL.test(`${match[2]}`.toUpperCase())) continue;
    const found = parseFlightNumber(`${match[1]}${match[2]}`);
    if (found) return found;
  }

  return null;
}

/**
 * Airports, by the names and codes that actually appear on a job sheet.
 *
 * Deliberately not an exhaustive world list. These are the ones a London
 * operator meets, plus the generic words, because the purpose is only to
 * decide a job type the operator can see and change — not to resolve a
 * terminal.
 */
const AIRPORT_WORDS = [
  'heathrow', 'gatwick', 'stansted', 'luton', 'london city airport',
  'farnborough', 'biggin hill', 'northolt', 'southend', 'birmingham airport',
  'manchester airport', 'airport', 'aerodrome', 'terminal ',
];

const AIRPORT_CODES = /\b(LHR|LGW|STN|LTN|LCY|SEN|FAB|BQH|NHT|MAN|BHX|EDI|GLA)\b/;

/**
 * Whether an address is an airport.
 *
 * Used to pick the job type, which matters for more than a label: the free
 * wait-time allowance is 45 minutes for an airport arrival and 15 otherwise,
 * so a misclassified airport job starts billing waiting half an hour early.
 * It is a suggestion on a form the operator reads, which is the right place
 * for a judgement this rough.
 */
export function looksLikeAirport(address: string | null): boolean {
  if (!address) return false;

  const text = address.toLowerCase();
  if (AIRPORT_WORDS.some((word) => text.includes(word))) return true;

  return AIRPORT_CODES.test(address.toUpperCase());
}
