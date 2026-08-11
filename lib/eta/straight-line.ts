import {
  ASSUMED_URBAN_KMH,
  haversineMetres,
  ROAD_WINDING_FACTOR,
  type EtaProvider,
  type Estimate,
  type Point,
} from './types';

/**
 * The provider that is always available.
 *
 * No key, no network, no bill. It knows nothing about roads and less about
 * traffic, so it is wrong — but wrong within a band, and a band is what the
 * client is told. It exists so that turning on live location is useful on the
 * day it is turned on, rather than after somebody has been through Google
 * Cloud billing.
 */
/**
 * Typed as never returning null, unlike the seam it satisfies. A routing
 * provider can be down; arithmetic cannot, and callers that fall back to
 * this one should not have to re-check.
 */
export interface StraightLineProvider extends EtaProvider {
  estimate(from: Point, to: Point): Promise<Estimate>;
}

export function straightLineProvider(
  options: { kmh?: number } = {},
): StraightLineProvider {
  const kmh = options.kmh ?? ASSUMED_URBAN_KMH;

  return {
    name: 'straight-line',
    async estimate(from: Point, to: Point): Promise<Estimate> {
      const metres = haversineMetres(from, to) * ROAD_WINDING_FACTOR;
      const minutes = metres / 1000 / kmh * 60;

      return {
        minutes: Math.max(0, minutes),
        metres: Math.round(metres),
        source: 'straight-line',
        trafficAware: false,
      };
    },
  };
}
