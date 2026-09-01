import type {
  FlightConfig,
  FlightProvider,
  FlightReport,
  FlightResult,
  FlightState,
} from './types';

/**
 * AeroDataBox, over RapidAPI.
 *
 * Picked as the first adapter because it answers the one question this system
 * asks — "when will this flight number actually land on this date" — on a
 * per-call price rather than an enterprise contract, and it reports a revised
 * arrival time rather than only a status word. A provider that says "Delayed"
 * without saying by how long cannot move a pickup.
 *
 * **The response mapping is unverified.** Be precise about which half:
 *
 * The *request* has reached the live service. A call with a deliberately
 * invalid key came back `403 {"message":"You are not subscribed to this
 * API."}` — RapidAPI resolved the path and read the key header, rather than
 * 404ing an endpoint that does not exist or complaining the key was missing.
 * So the host, the path and the header names are right.
 *
 * The *response* half below — field names, the `utc`/`local` time shape, the
 * status vocabulary in `STATES` — still follows the published documentation
 * and nothing else. It is unit-tested against fixtures written from those
 * docs, which proves the mapping and not the docs. `npm run check:flights`
 * makes one real call and prints the raw payload beside the mapped result for
 * exactly this; run it with a subscribed key and correct the fixtures before
 * switching a customer on.
 *
 * Everything that decides anything is in `./decide.ts` and knows nothing
 * about this file, so a wrong guess here is a wrong guess in one place.
 */

const HOST = 'aerodatabox.p.rapidapi.com';

/**
 * Their status words, mapped down to the six that change a decision.
 *
 * Anything unlisted becomes `UNKNOWN` rather than being guessed at: an
 * unrecognised status that fell through to `SCHEDULED` would present a
 * cancelled flight as running normally.
 */
const STATES: Record<string, FlightState> = {
  unknown: 'UNKNOWN',
  expected: 'SCHEDULED',
  expectedtogatearrive: 'ACTIVE',
  enroute: 'ACTIVE',
  checkin: 'SCHEDULED',
  boarding: 'SCHEDULED',
  gateclosed: 'SCHEDULED',
  departed: 'ACTIVE',
  delayed: 'ACTIVE',
  approaching: 'ACTIVE',
  arrived: 'LANDED',
  landed: 'LANDED',
  gatearrived: 'LANDED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  diverted: 'DIVERTED',
  canceleduncertain: 'CANCELLED',
};

export const aeroDataBox: FlightProvider = {
  name: 'aerodatabox',
  lookup: (config, flightNumber, date) =>
    lookupFlight(config, flightNumber, date),
};

export async function lookupFlight(
  config: FlightConfig,
  flightNumber: string,
  date: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FlightResult<FlightReport | null>> {
  if (!config.apiKey) {
    return { ok: false, code: 'NO_KEY', message: 'No API key configured' };
  }

  const url =
    `https://${HOST}/flights/number/${encodeURIComponent(flightNumber)}/${encodeURIComponent(date)}` +
    // Codeshares would return the same aeroplane several times under several
    // numbers, and cargo legs are not what anybody is being met off.
    '?withAircraftImage=false&withLocation=false';

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'x-rapidapi-key': config.apiKey,
        'x-rapidapi-host': HOST,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    return {
      ok: false,
      code: 'UNREACHABLE',
      message:
        error instanceof Error ? error.message : 'Could not reach the provider',
    };
  }

  // Their "no such flight on that date" answer, and a normal one: an
  // operator typing a flight number that does not fly on a Tuesday is a
  // data-quality problem, not a fault.
  if (response.status === 404) return { ok: true, value: null };

  if (!response.ok) {
    return {
      ok: false,
      code: `HTTP_${response.status}`,
      message: `${response.status} ${await safeText(response)}`.slice(0, 300),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      code: 'BAD_JSON',
      message: 'Provider sent something that is not JSON',
    };
  }

  return { ok: true, value: mapFlight(body, flightNumber) };
}

/**
 * Their payload to ours.
 *
 * Exported so the mapping can be tested without a network, which is the only
 * part of this file that can be tested at all.
 */
export function mapFlight(
  body: unknown,
  flightNumber: string,
): FlightReport | null {
  const legs = Array.isArray(body) ? body : [];
  if (legs.length === 0) return null;

  /*
   * A flight number can return several legs on one date: a multi-sector
   * service, or the same number operating twice. The one being met is the
   * one arriving — and where there is genuinely more than one, the earliest
   * arrival, because meeting the wrong leg is a car at an empty gate.
   */
  const leg = legs
    .filter(isRecord)
    .sort((a, b) => arrivalKey(a) - arrivalKey(b))[0];
  if (!leg) return null;

  const arrival = isRecord(leg.arrival) ? leg.arrival : {};
  const departure = isRecord(leg.departure) ? leg.departure : {};

  return {
    flightNumber,
    state: mapState(leg.status),
    scheduledArrival: timeOf(arrival.scheduledTime),
    // "Revised" is their word for the current estimate.
    estimatedArrival:
      timeOf(arrival.revisedTime) ?? timeOf(arrival.predictedTime),
    actualArrival: timeOf(arrival.actualTime) ?? timeOf(arrival.runwayTime),
    origin: airportCode(departure.airport),
    destination: airportCode(arrival.airport),
    terminal: typeof arrival.terminal === 'string' ? arrival.terminal : null,
  };
}

export function mapState(status: unknown): FlightState {
  if (typeof status !== 'string') return 'UNKNOWN';
  return STATES[status.toLowerCase().replace(/[^a-z]/g, '')] ?? 'UNKNOWN';
}

/**
 * Their times come as `{ utc: "2026-09-15 06:00Z", local: "..." }`.
 *
 * The UTC one, always. The local string carries an offset that is right for
 * the airport and wrong for anything this system does with it, and a time
 * read without its offset would be out by the offset — at Heathrow in
 * summer, an hour, which is exactly the size of error nobody notices until a
 * driver is an hour early.
 */
function timeOf(value: unknown): Date | null {
  if (!isRecord(value)) return null;
  const utc = value.utc;
  if (typeof utc !== 'string') return null;

  // `2026-09-15 06:00Z` is not what `Date` expects; `2026-09-15T06:00Z` is.
  const parsed = new Date(utc.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function airportCode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.iata === 'string') return value.iata;
  if (typeof value.icao === 'string') return value.icao;
  return null;
}

function arrivalKey(leg: Record<string, unknown>): number {
  const arrival = isRecord(leg.arrival) ? leg.arrival : {};
  const time = timeOf(arrival.scheduledTime) ?? timeOf(arrival.revisedTime);
  return time ? time.getTime() : Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
