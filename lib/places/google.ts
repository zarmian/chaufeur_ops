import { extractPostcode, type PlaceDetail, type PlaceProvider, type PlaceSuggestion } from './types';

/**
 * Google Places (New) — autocomplete and details.
 *
 * Over `fetch` rather than the SDK: two calls, and a dependency that pulls in
 * a browser-oriented client for the sake of them is a dependency that has to
 * be justified at every upgrade.
 *
 * Two things this file is careful about, both about money:
 *
 *   - the key never leaves the server, so nobody can spend it but us;
 *   - a session token is passed through, so a search that took nine
 *     keystrokes is billed as one session rather than nine requests.
 *
 * Biased towards the configured country and, when one is set, a point — a
 * London operator typing "victoria" means the station, not the Australian
 * state.
 */

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';

export interface GoogleOptions {
  apiKey: string;
  /** ISO 3166-1 alpha-2, lower case. Defaults to the configured locale's. */
  country?: string;
  /** Bias results towards here. Optional; without it Google guesses. */
  bias?: { lat: number; lng: number; radiusMetres: number };
  fetchImpl?: typeof fetch;
}

interface AutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
}

interface DetailsResponse {
  id?: string;
  formattedAddress?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
}

export function googleProvider(options: GoogleOptions): PlaceProvider {
  const call = options.fetchImpl ?? fetch;

  return {
    name: 'google',

    async suggest(query, { sessionToken, signal } = {}) {
      const body: Record<string, unknown> = {
        input: query,
        // Restricting the country cuts the noise dramatically and costs
        // nothing: a UK operator does not want a Victoria in Australia.
        includedRegionCodes: [(options.country ?? 'gb').toLowerCase()],
        ...(sessionToken ? { sessionToken } : {}),
      };

      if (options.bias) {
        body.locationBias = {
          circle: {
            center: {
              latitude: options.bias.lat,
              longitude: options.bias.lng,
            },
            radius: options.bias.radiusMetres,
          },
        };
      }

      const response = await call(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': options.apiKey,
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        throw new Error(await describeFailure(response));
      }

      const json = (await response.json()) as AutocompleteResponse;

      return (json.suggestions ?? []).flatMap<PlaceSuggestion>((suggestion) => {
        const prediction = suggestion.placePrediction;
        if (!prediction?.placeId) return [];

        const primary =
          prediction.structuredFormat?.mainText?.text ?? prediction.text?.text ?? '';
        if (primary === '') return [];

        return [
          {
            id: prediction.placeId,
            primary,
            secondary: prediction.structuredFormat?.secondaryText?.text ?? '',
            source: 'google',
          },
        ];
      });
    },

    async detail(id, { sessionToken, signal } = {}) {
      const url = new URL(`${DETAILS_URL}/${encodeURIComponent(id)}`);
      // Closes the session, so the autocomplete requests that led here are
      // billed together with this one lookup.
      if (sessionToken) url.searchParams.set('sessionToken', sessionToken);

      const response = await call(url.toString(), {
        headers: {
          'X-Goog-Api-Key': options.apiKey,
          'X-Goog-FieldMask':
            'id,displayName,formattedAddress,location,addressComponents',
        },
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        throw new Error(await describeFailure(response));
      }

      const json = (await response.json()) as DetailsResponse;
      const address = json.formattedAddress ?? '';

      return {
        label: json.displayName?.text ?? address,
        address,
        // The component is authoritative; the formatted address is the
        // fallback for the handful of places that carry no postal_code.
        postcode:
          componentOf(json, 'postal_code') ?? extractPostcode(address) ?? null,
        lat: json.location?.latitude ?? null,
        lng: json.location?.longitude ?? null,
      } satisfies PlaceDetail;
    },
  };
}

function componentOf(json: DetailsResponse, type: string): string | null {
  const found = json.addressComponents?.find((component) =>
    component.types?.includes(type),
  );
  return found?.longText ?? found?.shortText ?? null;
}

/**
 * Google's own message, when there is one.
 *
 * A billing failure and a bad key produce very different fixes, and
 * "lookup failed" sends the operator to neither.
 */
async function describeFailure(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as {
      error?: { message?: string; status?: string };
    };
    if (json.error?.message) {
      return `Google Places: ${json.error.message}`;
    }
  } catch {
    // Fall through to the status.
  }
  return `Google Places returned ${response.status}`;
}
