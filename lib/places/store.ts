import { withAudit, type AuditContext } from '../audit';
import { getLocaleConfig } from '../locale-store';
import { prisma } from '../prisma';
import { loadZones } from '../pricing/rate-card';
import { zoneForPostcode } from '../pricing/zones';
import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
} from '../secret-store';
import { googleProvider } from './google';
import { postcodesProvider } from './postcodes';
import {
  extractPostcode,
  type PlaceDetail,
  type PlaceProvider,
  type PlaceProviderName,
  type PlaceSuggestion,
} from './types';

/**
 * Which provider is in use, and what it found.
 *
 * The key lives here and only here. Every lookup is proxied through this
 * application: a Places key in the browser is a key anybody can spend, and
 * the bill arrives regardless of who spent it.
 */

const KEY = 'places.provider';

export interface PlacesConfig {
  provider: PlaceProviderName;
  /** Never returned to a browser — the settings screen is told only this. */
  keySet: boolean;
  country: string;
  bias: { lat: number; lng: number; radiusMetres: number } | null;
}

export async function getPlacesConfig(): Promise<PlacesConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;

  const locale = await getLocaleConfig();

  return {
    provider: stored.provider === 'google' ? 'google' : 'postcodes',
    keySet: typeof stored.apiKey === 'string' && stored.apiKey !== '',
    country:
      typeof stored.country === 'string' && stored.country.length === 2
        ? stored.country.toLowerCase()
        : countryFromLocale(locale.locale),
    bias:
      isNumber(stored.biasLat) && isNumber(stored.biasLng)
        ? {
            lat: stored.biasLat,
            lng: stored.biasLng,
            radiusMetres: isNumber(stored.biasRadius) ? stored.biasRadius : 40_000,
          }
        : null,
  };
}

export interface PlacesInput {
  provider: PlaceProviderName;
  /** Blank leaves whatever is stored alone, so saving does not wipe a key. */
  apiKey: string;
  country: string;
  biasLat: number | null;
  biasLng: number | null;
  biasRadiusMetres: number | null;
}

export type PlacesResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function savePlacesConfig(
  input: PlacesInput,
  context: AuditContext,
): Promise<PlacesResult> {
  const existing = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  const wantsKey = input.apiKey.trim() !== '';
  if (wantsKey && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving a Places key — generate one with `openssl rand -hex 32`. Nothing is stored in plaintext.',
    };
  }

  const apiKey = wantsKey ? encryptSecret(input.apiKey.trim()) : (stored.apiKey ?? null);

  if (input.provider === 'google' && !apiKey) {
    return {
      ok: false,
      code: 'NO_KEY',
      message:
        'Google Places needs a key. Paste one, or leave the provider on postcode lookup, which needs nothing.',
    };
  }

  const value = {
    provider: input.provider,
    apiKey,
    country: input.country.trim().toLowerCase().slice(0, 2),
    biasLat: input.biasLat,
    biasLng: input.biasLng,
    biasRadius: input.biasRadiusMetres,
  };

  await withAudit(
    'Setting',
    'update',
    async (tx) => {
      // Records that a key changed, never what it is.
      const before = { key: KEY, provider: stored.provider, keySet: Boolean(stored.apiKey) };
      await tx.setting.upsert({
        where: { key: KEY },
        update: { value },
        create: { key: KEY, value },
      });
      return {
        entityId: KEY,
        before,
        after: { key: KEY, provider: value.provider, keySet: Boolean(apiKey) },
        result: null,
      };
    },
    context,
  );

  return { ok: true };
}

/**
 * The configured provider, ready to call.
 *
 * Falls back to `postcodes.io` when Google is selected but unusable — a
 * missing encryption key, a deleted setting. A booking form that stops
 * suggesting anything because a credential went missing is worse than one
 * that suggests less.
 */
export async function resolveProvider(): Promise<PlaceProvider> {
  const config = await getPlacesConfig();

  if (config.provider === 'google') {
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    const stored = (row?.value ?? {}) as Record<string, unknown>;
    const apiKey =
      typeof stored.apiKey === 'string' && stored.apiKey !== ''
        ? decryptSecret(stored.apiKey)
        : null;

    if (apiKey) {
      return googleProvider({
        apiKey,
        country: config.country,
        ...(config.bias ? { bias: config.bias } : {}),
      });
    }
  }

  return postcodesProvider();
}

/**
 * Suggestions, saved locations first.
 *
 * Spec 4.8.6.6: the second booking to the same hotel needs no lookup at all,
 * which only works if what was saved last time is offered before anything is
 * asked of a paid provider. Ordered by use, so the addresses this operator
 * actually books rise to the top.
 *
 * A provider failure degrades to the saved list rather than emptying the
 * field. Google being down should not stop somebody taking a booking.
 */
export async function suggestPlaces(
  query: string,
  options: { sessionToken?: string; limit?: number; clientId?: string | null } = {},
): Promise<{ suggestions: PlaceSuggestion[]; provider: PlaceProviderName; warning: string | null }> {
  const limit = options.limit ?? 8;
  const saved = await savedSuggestions(query, limit, options.clientId ?? null);

  const provider = await resolveProvider();
  let remote: PlaceSuggestion[] = [];
  let warning: string | null = null;

  try {
    remote = await provider.suggest(query, {
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    });
  } catch (error) {
    warning = error instanceof Error ? error.message : 'Address lookup is unavailable';
  }

  // Saved first, and a remote suggestion that duplicates one is dropped:
  // offering "The Dorchester" twice makes the operator choose between two
  // identical lines, one of which costs money to resolve.
  const seen = new Set(saved.map((suggestion) => key(suggestion)));
  const merged = [
    ...saved,
    ...remote.filter((suggestion) => !seen.has(key(suggestion))),
  ];

  return { suggestions: merged.slice(0, limit), provider: provider.name, warning };
}

function key(suggestion: PlaceSuggestion): string {
  return suggestion.primary.trim().toLowerCase();
}

/**
 * Saved locations matching what has been typed — spec 6.4.2 and 6.4.6.
 *
 * Ordered `useCount` then alphabetically, with **this client's favourites
 * ahead of everything**. That ordering is the whole value: a corporate
 * account whose people always go to the same office should not scroll past
 * Heathrow to find it, and that office will never out-rank Heathrow on a
 * count taken across the whole business.
 */
async function savedSuggestions(
  query: string,
  limit: number,
  clientId: string | null,
): Promise<PlaceSuggestion[]> {
  const typed = query.trim();
  if (typed === '') return [];

  const matching = {
    OR: [
      { label: { contains: typed, mode: 'insensitive' as const } },
      { address: { contains: typed, mode: 'insensitive' as const } },
      { postcode: { contains: typed, mode: 'insensitive' as const } },
    ],
  };

  const [favourites, locations] = await Promise.all([
    clientId
      ? prisma.location.findMany({
          where: { ...matching, favouriteOf: { some: { clientId } } },
          orderBy: [{ useCount: 'desc' }, { label: 'asc' }],
          take: limit,
        })
      : Promise.resolve([]),
    prisma.location.findMany({
      where: matching,
      orderBy: [{ useCount: 'desc' }, { label: 'asc' }],
      take: limit,
    }),
  ]);

  const favouriteIds = new Set(favourites.map((location) => location.id));
  const ordered = [
    ...favourites,
    ...locations.filter((location) => !favouriteIds.has(location.id)),
  ];

  return ordered.slice(0, limit).map((location) => ({
    id: `saved:${location.id}`,
    primary: location.label,
    secondary: location.address,
    postcode: location.postcode,
    lat: location.lat,
    lng: location.lng,
    source: 'saved' as const,
  }));
}

/**
 * Resolve a chosen suggestion, and remember it.
 *
 * Spec 4.8.6.5 and 4.8.6.6: the formatted address, postcode and coordinates
 * land on the job, and the place becomes a `Location` so the next booking to
 * it needs no lookup. Saving is best-effort — failing to remember an address
 * must never stop somebody taking the booking that used it.
 */
export async function resolvePlace(
  id: string,
  options: { sessionToken?: string } = {},
): Promise<(PlaceDetail & { locationId: string | null; zoneId: string | null }) | null> {
  if (id.startsWith('saved:')) {
    const location = await prisma.location.findUnique({
      where: { id: id.slice('saved:'.length) },
    });
    if (!location) return null;

    return {
      label: location.label,
      address: location.address,
      postcode: location.postcode,
      lat: location.lat,
      lng: location.lng,
      locationId: location.id,
      zoneId: location.zoneId,
    };
  }

  const provider = await resolveProvider();
  const detail = await provider.detail(id, {
    ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
  });
  if (!detail) return null;

  const postcode = detail.postcode ?? extractPostcode(detail.address);
  // Spec 4.8.6.7: the postcode feeds zone resolution directly, so a
  // correctly-picked address prices correctly without a second step. Matched
  // on the outward half, which is what a zone claims.
  const zone = postcode
    ? zoneForPostcode(outwardOf(postcode), await loadZones())
    : null;

  const saved = await rememberLocation({ ...detail, postcode }, zone?.zoneId ?? null);

  return {
    ...detail,
    postcode,
    locationId: saved,
    zoneId: zone?.zoneId ?? null,
  };
}

/**
 * Save a chosen place as a `Location`, unless it is already one.
 *
 * Matched on the label, case-insensitively, because that is what the operator
 * will type next time. Duplicate labels are the thing that makes a saved-
 * locations list useless, so a near-miss is treated as a hit.
 */
async function rememberLocation(
  detail: PlaceDetail,
  zoneId: string | null,
): Promise<string | null> {
  try {
    const existing = await prisma.location.findFirst({
      where: { label: { equals: detail.label, mode: 'insensitive' } },
      select: { id: true },
    });

    if (existing) {
      await prisma.location.update({
        where: { id: existing.id },
        data: { useCount: { increment: 1 } },
      });
      return existing.id;
    }

    const created = await prisma.location.create({
      data: {
        label: detail.label.slice(0, 200),
        address: detail.address.slice(0, 400),
        postcode: detail.postcode,
        lat: detail.lat,
        lng: detail.lng,
        zoneId,
        useCount: 1,
      },
    });
    return created.id;
  } catch {
    // Remembering is a convenience. Losing it must not lose the booking.
    return null;
  }
}

/** `SW1A 1AA` -> `SW1A`. A zone claims the outward half, never the inward. */
function outwardOf(postcode: string): string {
  return postcode.trim().split(/\s+/)[0] ?? postcode;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `en-GB` -> `gb`. Falls back to the UK, matching every other default here. */
function countryFromLocale(locale: string): string {
  const region = locale.split(/[-_]/)[1];
  return region && region.length === 2 ? region.toLowerCase() : 'gb';
}
