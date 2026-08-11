import type { EtaProvider, Estimate, Point } from './types';

/**
 * Google Routes — drive time with live traffic.
 *
 * Over `fetch` rather than the SDK, for the reason given in
 * `lib/places/google.ts`: two fields off one endpoint does not justify a
 * dependency that has to be re-justified at every upgrade.
 *
 * `computeRoutes` rather than the Distance Matrix: one origin and one
 * destination is what this asks, matrix pricing is for the general case, and
 * `TRAFFIC_AWARE` is the whole reason for paying at all.
 *
 * The field mask is not decoration — Routes bills by what you ask for, and
 * asking for the polyline of a journey nobody will draw is money spent on
 * bytes that get discarded here.
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export interface GoogleRoutesOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Bounded so a hanging provider cannot hold up a client's text. */
  timeoutMs?: number;
}

interface RoutesResponse {
  routes?: Array<{
    /** Seconds, as a string with a trailing `s` — "737s". */
    duration?: string;
    distanceMeters?: number;
  }>;
}

/** Routes returns durations as `"737s"`. */
function parseSeconds(duration: string | undefined): number | null {
  if (typeof duration !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

export function googleRoutesProvider(options: GoogleRoutesOptions): EtaProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;

  return {
    name: 'google',
    async estimate(from: Point, to: Point, callOptions = {}): Promise<Estimate | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      callOptions.signal?.addEventListener('abort', () => controller.abort());

      try {
        const response = await doFetch(ROUTES_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': options.apiKey,
            'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
          },
          body: JSON.stringify({
            origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
            destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
          }),
        });

        if (!response.ok) return null;

        const body = (await response.json()) as RoutesResponse;
        const route = body.routes?.[0];
        const seconds = parseSeconds(route?.duration);
        if (seconds === null) return null;

        return {
          minutes: seconds / 60,
          metres: typeof route?.distanceMeters === 'number' ? route.distanceMeters : 0,
          source: 'google',
          trafficAware: true,
        };
      } catch {
        // A provider that is down, slow or rate-limited is not an error the
        // client should experience. The caller falls back to the straight
        // line, which is always there.
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
