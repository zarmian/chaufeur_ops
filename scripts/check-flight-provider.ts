/**
 * One real call to the flight provider, printed both ways.
 *
 *   npm run check:flights -- BA117 2026-09-15
 *   FLIGHT_API_KEY=... npm run check:flights -- BA117 2026-09-15
 *
 * `lib/flights/aerodatabox.ts` was written from AeroDataBox's published
 * documentation. Its *request* half is proven — a call with an invalid key
 * comes back `403 "You are not subscribed to this API"`, so RapidAPI resolves
 * the path and reads the headers. Its *response* half is not: the field names,
 * the time format and the status vocabulary are still assumptions, and the
 * unit tests check them against fixtures written from the same docs, which
 * proves the mapping and not the docs.
 *
 * This is that call. It prints the raw payload beside what the adapter made of
 * it, so the two can be read against each other in one screen:
 *
 *   - a field arriving under a name the adapter does not look for shows up as
 *     `null` in the mapped half while sitting in plain view in the raw half
 *   - a status word not in the map shows as `UNKNOWN`, which is the safe
 *     direction but still wrong
 *   - a time that parses to `Invalid Date` or lands an hour out says the
 *     `utc`/`local` handling needs correcting
 *
 * Whatever comes back should be pasted into the fixtures in
 * `lib/flights/aerodatabox.test.ts`, replacing the invented ones. That is the
 * step `docs/specs/phase-6.5-flight-tracking.md` names in its definition of
 * done, and it is the one thing standing between the adapter and a customer.
 *
 * The key comes from `FLIGHT_API_KEY` if set, otherwise from this install's
 * saved settings — so it can be run before anything is configured, or after.
 * Nothing is written; this only reads.
 */

import { lookupFlight, mapFlight } from '../lib/flights/aerodatabox';
import { getFlightConfig } from '../lib/flights/store';
import { blankFlightConfig, normaliseFlightNumber } from '../lib/flights/types';

async function main(): Promise<void> {
  const [rawNumber, date] = process.argv.slice(2);

  if (!rawNumber || !date) {
    fail(
      'Usage: npm run check:flights -- <flight number> <YYYY-MM-DD>\n' +
        '  e.g. npm run check:flights -- BA117 2026-09-15\n\n' +
        'Pick a flight arriving today or tomorrow. A date far ahead returns the\n' +
        'timetable and nothing else, which tells you nothing about the fields\n' +
        'that matter — the revised and actual arrival times.',
    );
    return;
  }

  const flightNumber = normaliseFlightNumber(rawNumber);
  if (!flightNumber) {
    fail(`"${rawNumber}" is not a flight number this system recognises.`);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(`"${date}" is not a date. Use YYYY-MM-DD.`);
    return;
  }

  const config = await resolveConfig();
  if (!config.apiKey) {
    fail(
      'No provider key. Set one in Settings → Flight tracking, or pass it for\n' +
        'this run only:\n\n' +
        '  FLIGHT_API_KEY=... npm run check:flights -- BA117 2026-09-15',
    );
    return;
  }

  console.log(`Asking AeroDataBox about ${flightNumber} on ${date}.\n`);

  /*
   * The raw body is captured on the way past rather than asked for twice.
   *
   * A second call would be billed twice and could legitimately return
   * something different — an estimate that moved between the two — which is
   * the one thing that would make the comparison useless.
   */
  let raw: unknown = null;
  const capturing: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = await response.clone().text();
    try {
      raw = JSON.parse(body);
    } catch {
      raw = body;
    }
    return response;
  };

  const result = await lookupFlight(config, flightNumber, date, capturing);

  if (!result.ok) {
    console.log(`The call failed: ${result.code} — ${result.message}\n`);
    if (raw !== null) {
      console.log('What came back:\n');
      console.log(JSON.stringify(raw, null, 2).slice(0, 4000));
    }
    process.exitCode = 1;
    return;
  }

  console.log('--- Raw payload -------------------------------------------\n');
  console.log(JSON.stringify(raw, null, 2).slice(0, 8000));

  console.log(
    '\n--- What the adapter made of it ---------------------------\n',
  );
  if (result.value === null) {
    console.log(
      'null — the provider had no such flight on that date.\n\n' +
        'That is a legitimate answer, but it proves nothing about the mapping.\n' +
        'Try a flight that is definitely operating today.',
    );
    return;
  }
  console.log(JSON.stringify(result.value, null, 2));

  report(result.value, raw, flightNumber);
}

/**
 * What the adapter should be checked on, in the order it will bite.
 *
 * Printed rather than left to be noticed: somebody running this once, months
 * from now, should not have to hold the whole mapping in their head to know
 * what they are looking at.
 */
function report(
  value: NonNullable<Awaited<ReturnType<typeof mapFlight>>>,
  raw: unknown,
  flightNumber: string,
): void {
  console.log(
    '\n--- Read these ---------------------------------------------\n',
  );

  const notes: string[] = [];

  if (value.state === 'UNKNOWN') {
    notes.push(
      'state is UNKNOWN — the provider sent a status word the adapter does not\n' +
        '  map. Find it in the raw payload above and add it to STATES in\n' +
        '  lib/flights/aerodatabox.ts. It fails safe (nothing is moved) but a\n' +
        '  cancelled flight reading as UNKNOWN is a car sent to meet nobody.',
    );
  }

  if (!value.scheduledArrival) {
    notes.push(
      'scheduledArrival is null — the buffer is measured against it, so with\n' +
        '  nothing here every job flags NO_BASELINE and no pickup ever moves.\n' +
        '  Check what the arrival object is actually called in the raw payload.',
    );
  }

  if (
    value.scheduledArrival &&
    Number.isNaN(value.scheduledArrival.getTime())
  ) {
    notes.push('scheduledArrival did not parse — the time format has changed.');
  }

  if (!value.estimatedArrival && !value.actualArrival) {
    notes.push(
      'neither estimatedArrival nor actualArrival is set. Expected for a flight\n' +
        '  days out; on one operating today it means `revisedTime`/`actualTime`\n' +
        '  are named something else, and without them a delay is invisible.',
    );
  }

  if (!value.destination) {
    notes.push('destination is null — check the arrival airport field name.');
  }

  if (notes.length === 0) {
    console.log('Everything the decision logic needs came through.\n');
    console.log(
      'Compare the times above against a public flight tracker for\n' +
        `${flightNumber}. They are UTC. An hour out in summer means the adapter is\n` +
        'reading the local string instead of the UTC one.',
    );
  } else {
    for (const note of notes) console.log(`• ${note}\n`);
  }

  console.log(
    '\nThen update the fixtures in lib/flights/aerodatabox.test.ts to match the\n' +
      'raw payload above, and re-run `npm run test:unit`.',
  );

  // Referenced so a payload that is an object rather than an array — a shape
  // change on its own — is visible in the exit status rather than only in
  // eight thousand characters of output.
  if (!Array.isArray(raw)) {
    console.log(
      '\nNote: the payload is not an array. `mapFlight` expects a list of legs;\n' +
        'a single object means the response shape has changed.',
    );
    process.exitCode = 1;
  }
}

/** The saved settings, or a blank config carrying only a key from the env. */
async function resolveConfig() {
  const fromEnv = process.env.FLIGHT_API_KEY?.trim();
  if (fromEnv) {
    return { ...blankFlightConfig(), enabled: true, apiKey: fromEnv };
  }

  try {
    return await getFlightConfig();
  } catch {
    // No database reachable is fine: with a key in the environment this needs
    // nothing else, and saying so beats a stack trace.
    return blankFlightConfig();
  }
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nCould not complete the check:', error);
  process.exitCode = 1;
});
