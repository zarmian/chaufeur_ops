import { extractPostcode, type PlaceDetail, type PlaceProvider } from './types';

/**
 * `postcodes.io` — the zero-configuration fallback.
 *
 * No key, no billing, no account. It cannot find "The Dorchester", so it is
 * not a substitute for Places; what it does is make a postcode typed into the
 * pickup field resolve to a real, validated postcode with coordinates, which
 * is enough for zone resolution to price the job correctly.
 *
 * That is the whole point of it being the default: spec 4.8.6.4 asks that the
 * system work with no provider configured, and "works" should mean more than
 * "does nothing quietly".
 */

const BASE = 'https://api.postcodes.io';

export interface PostcodesOptions {
  fetchImpl?: typeof fetch;
}

interface Lookup {
  result?: {
    postcode?: string;
    latitude?: number;
    longitude?: number;
    admin_district?: string;
    admin_ward?: string;
    region?: string;
  } | null;
}

interface Autocomplete {
  result?: string[] | null;
}

export function postcodesProvider(
  options: PostcodesOptions = {},
): PlaceProvider {
  const call = options.fetchImpl ?? fetch;

  return {
    name: 'postcodes',

    async suggest(query, { signal } = {}) {
      const typed = query.trim();
      // Only ever asked about postcodes. A street name sent here returns
      // nothing, and pretending otherwise would make the field look broken.
      const candidate = extractPostcode(typed) ?? typed;
      if (candidate.length < 2) return [];

      const response = await call(
        `${BASE}/postcodes/${encodeURIComponent(candidate)}/autocomplete`,
        signal ? { signal } : {},
      );
      if (!response.ok) return [];

      const json = (await response.json()) as Autocomplete;

      return (json.result ?? []).slice(0, 8).map((postcode) => ({
        id: postcode,
        primary: postcode,
        secondary: 'UK postcode',
        postcode,
        source: 'postcodes' as const,
      }));
    },

    async detail(id, { signal } = {}) {
      const response = await call(
        `${BASE}/postcodes/${encodeURIComponent(id)}`,
        signal ? { signal } : {},
      );
      if (!response.ok) return null;

      const json = (await response.json()) as Lookup;
      const result = json.result;
      if (!result?.postcode) return null;

      // Ward, district, region — the closest thing to an address a postcode
      // lookup can honestly give. Not passed off as a street address.
      const parts = [result.admin_ward, result.admin_district, result.region]
        .filter((part): part is string => Boolean(part))
        .filter((part, index, all) => all.indexOf(part) === index);

      const address = [...parts, result.postcode].join(', ');

      return {
        /*
         * The area, not the bare code.
         *
         * This label is what lands in the pickup box, and from there on the
         * driver's job card. "W1K 1QA" tells them nothing they can navigate by
         * until they have typed it into something else; "Mayfair, Westminster,
         * London, W1K 1QA" at least says where they are going. The postcode is
         * still carried separately, so pricing and zone resolution are
         * unaffected either way.
         */
        label: address,
        address,
        postcode: result.postcode,
        lat: result.latitude ?? null,
        lng: result.longitude ?? null,
      } satisfies PlaceDetail;
    },
  };
}
