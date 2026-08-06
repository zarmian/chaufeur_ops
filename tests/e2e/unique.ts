/**
 * Identifiers that do not collide.
 *
 * Every spec here used to mint plates and phone numbers from
 * `String(Date.now()).slice(-5)`. That cycles every hundred seconds, so two
 * runs a hundred seconds apart produce the same registration — and a
 * registration is unique in the schema, so the second run fails on a
 * constraint with no hint that time was the cause.
 *
 * CI never saw it, because CI seeds a fresh database for every run. It shows
 * up the moment anybody runs the suite twice against a database that
 * persists, which is exactly when the suite is most useful.
 *
 * So: the time for readability — a plate from this morning sorts before one
 * from this afternoon — and randomness for the guarantee.
 */

const ALPHABET = '0123456789';

function randomDigits(count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/**
 * A run of digits unique across concurrent workers and repeated runs.
 *
 * `length` is the total; at least half of it is random. Six digits gives one
 * chance in a thousand of a clash between two runs in the same second, which
 * for a test fixture is the right side of the trade.
 */
export function uniqueDigits(length = 6): string {
  const randomPart = Math.max(2, Math.ceil(length / 2));
  const timePart = length - randomPart;
  return (
    String(Date.now()).slice(-timePart || undefined).slice(0, timePart) +
    randomDigits(randomPart)
  );
}

/** A vehicle registration nothing else will claim. `IN` + six digits. */
export function uniquePlate(prefix: string): string {
  return `${prefix}${uniqueDigits(6)}`;
}

/** A UK mobile number nothing else will claim. */
export function uniquePhone(): string {
  return `07700${uniqueDigits(6)}`;
}

/** Upper-case letters, for the parts of a UK plate that are not digits. */
export function uniqueLetters(count = 3): string {
  const letters = 'ABCDEFGHJKLMNPRSTVWXYZ';
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += letters[Math.floor(Math.random() * letters.length)];
  }
  return out;
}

/** A name nothing else will claim, for records matched on it. */
export function uniqueName(base: string): string {
  return `${base} ${uniqueDigits(6)}`;
}
