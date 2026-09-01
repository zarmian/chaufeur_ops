/**
 * Flight tracking, as a shape rather than an integration.
 *
 * Airport work is most of what this fleet does, and a flight that lands ninety
 * minutes late costs the same money twice: the driver sits in the car park on
 * a wait-time clock the client argues about afterwards, and the car is not
 * where it was supposed to be next. Today the only warning is a passenger
 * texting the office, or nothing at all.
 *
 * The providers that sell this data differ wildly — in price, in how far ahead
 * they will give a schedule, in whether they report estimated arrival at all —
 * and the one an install starts on is unlikely to be the one it stays on. So
 * the rest of the system talks to *this*: a flight number and a date go in, a
 * state and three timestamps come out. Adding a provider is one file.
 *
 * Client-safe: this module imports nothing, so the settings form can use the
 * types and the option lists without pulling a server module into the browser.
 *
 * **Tracking is optional throughout.** With no provider configured, every job
 * behaves exactly as it does today. Nothing here is required to book, dispatch
 * or complete an airport transfer.
 */

export type FlightProviderName = 'aerodatabox';

export const FLIGHT_PROVIDERS: Array<{
  value: FlightProviderName;
  label: string;
}> = [{ value: 'aerodatabox', label: 'AeroDataBox' }];

/**
 * What a flight is doing, reduced to the six states that change a decision.
 *
 * Providers report a dozen or more — "en route", "approaching", "on block",
 * "expected" — and the extra ones do not change what dispatch does. Mapping
 * down to these happens in the adapter, so a provider that invents a new
 * status cannot leak an unhandled string into the decision logic.
 */
export type FlightState =
  /** Filed, not yet airborne. */
  | 'SCHEDULED'
  /** Airborne. */
  | 'ACTIVE'
  /** On the ground at the destination. */
  | 'LANDED'
  /** Not operating. Nobody is being met. */
  | 'CANCELLED'
  /** Gone somewhere else. The pickup is wrong and a person must decide. */
  | 'DIVERTED'
  /** The provider had nothing, or nothing this code understands. */
  | 'UNKNOWN';

/** One flight, on one day, as the rest of the system needs it. */
export interface FlightReport {
  /** Normalised — `BA117`, never `ba 117`. */
  flightNumber: string;
  state: FlightState;
  /** What the timetable says. The baseline the booking was made against. */
  scheduledArrival: Date | null;
  /** The provider's current best guess. Null when it will not offer one. */
  estimatedArrival: Date | null;
  /** Wheels down. Once this exists nothing else matters. */
  actualArrival: Date | null;
  origin: string | null;
  destination: string | null;
  terminal: string | null;
}

export interface FlightConfig {
  provider: FlightProviderName;
  enabled: boolean;
  /** Secret. Encrypted at rest, never returned to a browser. */
  apiKey: string | null;
  /**
   * How far ahead to look. Beyond a day or two most providers have only the
   * timetable, which tells nobody anything they did not already know, and
   * every lookup is billed.
   */
  lookAheadHours: number;
  /** Don't ask again about the same flight more often than this. */
  refreshMinutes: number;
  /**
   * Move the pickup when the flight moves, rather than only flagging it.
   *
   * Off by default, and deliberately. Automatically rewriting a booking is
   * the right behaviour for most airport work and the wrong behaviour for the
   * client whose driver was told to be there at nine whatever the flight does
   * — and an install cannot find that out until it has happened once.
   */
  autoAdjust: boolean;
  /** Ignore a movement smaller than this. Nobody re-plans for six minutes. */
  minShiftMinutes: number;
  /**
   * Never pull a pickup *earlier* than this many minutes from now.
   *
   * A flight landing early is good news that becomes bad news if the answer
   * is to tell a driver forty minutes out that they are already late. Later
   * is always applied; earlier needs enough notice to be actionable.
   */
  minNoticeMinutes: number;
}

export function blankFlightConfig(): FlightConfig {
  return {
    provider: 'aerodatabox',
    enabled: false,
    apiKey: null,
    lookAheadHours: 36,
    refreshMinutes: 20,
    autoAdjust: false,
    minShiftMinutes: 15,
    minNoticeMinutes: 90,
  };
}

/** Whether tracking is configured enough to be worth calling. */
export function flightsUsable(config: FlightConfig): boolean {
  return config.enabled && Boolean(config.apiKey);
}

export type FlightResult<T> =
  { ok: true; value: T } | { ok: false; code: string; message: string };

/** What every provider adapter implements. */
export interface FlightProvider {
  name: FlightProviderName;
  /**
   * One flight, on one calendar date at the destination.
   *
   * The date matters: `BA117` is a different aeroplane every day, and asking
   * without one gets whichever leg the provider felt like returning.
   */
  lookup(
    config: FlightConfig,
    flightNumber: string,
    date: string,
  ): Promise<FlightResult<FlightReport | null>>;
}

/*
 * Carrier codes are not all two letters.
 *
 * IATA gives easyJet `U2` and Germanwings `4U`, and ICAO codes are three
 * letters — `EZY`, `BAW`. The two-character forms are tried before the
 * three-letter one on purpose: `[A-Z]{3}` would happily take `BA1` out of
 * `BA117` and call the flight number 17.
 */
const FLIGHT_NUMBER =
  /^(?:([A-Z][0-9]|[0-9][A-Z]|[A-Z]{2})|([A-Z]{3}))0*(\d{1,4})([A-Z]?)$/;

/**
 * `ba 117` → `BA117`, and `not a flight` → null.
 *
 * Operators type these into a free-text box at speed: with a space, without
 * one, in lower case, with the leading zeros the airline prints on the ticket.
 * `BA 0117` and `ba117` are the same aeroplane, and a cache keyed on the raw
 * text would ask the provider twice and bill twice for it.
 *
 * Leading zeros go because no provider wants them. A trailing letter stays —
 * some carriers really do fly `LH400A`.
 */
export function normaliseFlightNumber(input: string | null): string | null {
  if (!input) return null;
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = FLIGHT_NUMBER.exec(cleaned);
  if (!match) return null;
  const [, twoChar, threeLetter, digits, suffix] = match;
  return `${twoChar ?? threeLetter}${digits}${suffix}`;
}
