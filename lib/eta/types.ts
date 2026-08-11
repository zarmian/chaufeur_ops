/**
 * How long until the driver reaches the pickup, behind a seam.
 *
 * A routing provider is the accurate answer — it knows the road network and,
 * on a Tuesday at five, the traffic on it. But an install with no key still
 * has a driver's position and a pickup, and "about 20 minutes" from a
 * straight line is worth considerably more to a waiting client than silence.
 * So the seam has two implementations and the caller knows about neither.
 *
 * Pure types and pure arithmetic. Nothing here reaches the network or the
 * database, so it can be imported anywhere without dragging a key with it.
 */

export type EtaProviderName = 'google' | 'straight-line';

export interface Point {
  lat: number;
  lng: number;
}

export interface Estimate {
  /** Drive time in minutes. Never negative. */
  minutes: number;
  metres: number;
  /** Which implementation answered, for the operator-facing view. */
  source: EtaProviderName;
  /** True when traffic was accounted for. Straight lines never are. */
  trafficAware: boolean;
}

export interface EtaProvider {
  name: EtaProviderName;
  estimate(from: Point, to: Point, options?: { signal?: AbortSignal }): Promise<Estimate | null>;
}

const EARTH_RADIUS_METRES = 6_371_000;
const toRadians = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance. Metres. */
export function haversineMetres(from: Point, to: Point): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * How much further the road is than the crow's flight.
 *
 * 1.3 is the usual figure for a dense street grid. London is not a grid, but
 * it is not open country either, and the error this leaves is smaller than
 * the error from ignoring traffic — which is the one the straight-line
 * provider cannot do anything about anyway.
 */
export const ROAD_WINDING_FACTOR = 1.3;

/**
 * Assumed average speed, km/h, when there is no routing provider.
 *
 * Deliberately pessimistic. An ETA that arrives early is a client glancing up
 * at the door; one that arrives late is a client who has been told a lie.
 */
export const ASSUMED_URBAN_KMH = 24;

/**
 * A number of minutes as something a person would say.
 *
 * Banded, because a routing engine's "13.4 minutes" is false precision — it
 * cannot know which lights are red. Bands also mean two clients texted a
 * minute apart are told the same thing, which is what stops the number
 * looking like it is being made up.
 */
export function describeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return 'shortly';
  if (minutes < 3) return 'arriving now';
  if (minutes < 6) return 'about 5 minutes away';
  if (minutes >= 90) return 'over an hour away';

  const band = minutes < 30 ? 5 : 10;
  const rounded = Math.max(band, Math.round(minutes / band) * band);
  return `about ${rounded} minutes away`;
}

/**
 * Whether a position is too old to speak for where somebody is now.
 *
 * A driver's phone stops sending when it loses signal, and the last thing it
 * said goes on being true-looking indefinitely. Past this, the honest answer
 * is that we do not know.
 */
export function isStale(
  recordedAt: Date,
  now: Date = new Date(),
  maxAgeMinutes = 10,
): boolean {
  return now.getTime() - recordedAt.getTime() > maxAgeMinutes * 60_000;
}

/** Complete coordinates, or null. Guards against half-populated rows. */
export function pointFrom(
  lat: number | null | undefined,
  lng: number | null | undefined,
): Point | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
