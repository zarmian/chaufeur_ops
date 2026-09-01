import { withAudit, type AuditContext } from '../audit';
import { prisma } from '../prisma';
import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
} from '../secret-store';
import { aeroDataBox } from './aerodatabox';
import {
  blankFlightConfig,
  type FlightConfig,
  type FlightProvider,
  type FlightProviderName,
  type FlightReport,
  type FlightResult,
} from './types';

/**
 * Where the flight settings live, and where the answers are kept.
 *
 * The key is stored per install and encrypted (`lib/secret-store.ts`), on the
 * same terms as a payment gateway's: the settings screen is told whether one
 * is set, never what it is.
 *
 * Answers are cached in `FlightStatus`, keyed on the flight and the date
 * rather than on the job, because several jobs meet the same aeroplane — a
 * family in two cars, two clients off the same New York service — and every
 * lookup is billed. One row, one call, however many cars are going.
 */

const KEY = 'flights';

export async function getFlightConfig(): Promise<FlightConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const blank = blankFlightConfig();

  return {
    provider: 'aerodatabox',
    enabled: stored.enabled === true,
    apiKey: readSecret(stored.apiKey),
    lookAheadHours: positive(stored.lookAheadHours, blank.lookAheadHours),
    refreshMinutes: positive(stored.refreshMinutes, blank.refreshMinutes),
    autoAdjust: stored.autoAdjust === true,
    minShiftMinutes: positive(stored.minShiftMinutes, blank.minShiftMinutes),
    minNoticeMinutes: positive(stored.minNoticeMinutes, blank.minNoticeMinutes),
  };
}

function readSecret(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return decryptSecret(value);
}

/**
 * A stored number, or the default.
 *
 * Zero and negatives are rejected rather than clamped: a `minShiftMinutes` of
 * 0 would move a pickup for every one-minute revision, which on a busy
 * morning is a driver's phone buzzing every twenty minutes with nothing to
 * do about it.
 */
function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

export interface FlightConfigInput {
  enabled: boolean;
  autoAdjust: boolean;
  lookAheadHours: number;
  refreshMinutes: number;
  minShiftMinutes: number;
  minNoticeMinutes: number;
  /** Blank leaves whatever is stored alone, so saving does not wipe the key. */
  apiKey: string;
}

export async function saveFlightConfig(
  input: FlightConfigInput,
  context: AuditContext,
): Promise<FlightResult<null>> {
  const existing = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  const key = input.apiKey.trim();
  if (key !== '' && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving a flight provider key — generate one with `openssl rand -hex 32`. Nothing is stored in plaintext.',
    };
  }

  // Blank means "leave it". A form that wiped the key whenever somebody
  // adjusted a threshold would have people re-pasting a secret, which is
  // exactly when one ends up in a chat message.
  const value = {
    enabled: input.enabled,
    autoAdjust: input.autoAdjust,
    lookAheadHours: input.lookAheadHours,
    refreshMinutes: input.refreshMinutes,
    minShiftMinutes: input.minShiftMinutes,
    minNoticeMinutes: input.minNoticeMinutes,
    apiKey: key !== '' ? encryptSecret(key) : (stored.apiKey ?? null),
  };

  await withAudit(
    'Setting',
    'update',
    async (tx) => {
      await tx.setting.upsert({
        where: { key: KEY },
        create: { key: KEY, value },
        update: { value },
      });
      return {
        entityId: KEY,
        // The audit entry records that the key changed, never what it is: a
        // before-and-after snapshot would put the secret back in plaintext in
        // the one table nobody thinks to redact.
        before: redact(stored),
        after: redact(value),
        result: null,
      };
    },
    context,
  );

  return { ok: true, value: null };
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  const { apiKey, ...rest } = value;
  return { ...rest, keySet: Boolean(apiKey) };
}

const PROVIDERS: Record<FlightProviderName, FlightProvider> = {
  aerodatabox: aeroDataBox,
};

export function providerFor(name: FlightProviderName): FlightProvider {
  return PROVIDERS[name];
}

/**
 * The cached answer for one flight on one date, however stale.
 *
 * Staleness is the caller's decision — `shouldRefresh` in `./decide.ts` — so
 * this never quietly refuses to return something it has.
 */
export async function cachedFlight(flightNumber: string, on: Date) {
  return prisma.flightStatus.findUnique({
    where: {
      flightNumber_scheduledOn: { flightNumber, scheduledOn: dateOnly(on) },
    },
  });
}

/** Write what the provider said, replacing whatever was there. */
export async function recordFlight(
  report: FlightReport,
  on: Date,
  provider: FlightProviderName,
  raw: unknown,
): Promise<{ id: string }> {
  const data = {
    state: report.state,
    scheduledArrival: report.scheduledArrival,
    estimatedArrival: report.estimatedArrival,
    actualArrival: report.actualArrival,
    origin: report.origin,
    destination: report.destination,
    terminal: report.terminal,
    provider,
    // Kept verbatim so a mapping that turns out to be wrong can be diagnosed
    // from what actually arrived, rather than from what we made of it.
    raw: raw === undefined ? undefined : JSON.parse(JSON.stringify(raw)),
    checkedAt: new Date(),
  };

  return prisma.flightStatus.upsert({
    where: {
      flightNumber_scheduledOn: {
        flightNumber: report.flightNumber,
        scheduledOn: dateOnly(on),
      },
    },
    create: {
      flightNumber: report.flightNumber,
      scheduledOn: dateOnly(on),
      ...data,
    },
    update: data,
    select: { id: true },
  });
}

/**
 * Record that a lookup happened and found nothing.
 *
 * Without this, a flight number that does not fly on that date is asked about
 * on every run for as long as the job exists — billed every time, for the
 * same "no".
 */
export async function recordMiss(
  flightNumber: string,
  on: Date,
  provider: FlightProviderName,
): Promise<{ id: string }> {
  const data = {
    state: 'UNKNOWN' as const,
    scheduledArrival: null,
    estimatedArrival: null,
    actualArrival: null,
    provider,
    checkedAt: new Date(),
  };

  return prisma.flightStatus.upsert({
    where: {
      flightNumber_scheduledOn: { flightNumber, scheduledOn: dateOnly(on) },
    },
    create: { flightNumber, scheduledOn: dateOnly(on), ...data },
    update: data,
    select: { id: true },
  });
}

/**
 * The UTC calendar date, as a `@db.Date` column holds it.
 *
 * UTC and not the configured zone, deliberately: this is the key the provider
 * is asked on, and providers key on the flight's own schedule date. Using a
 * local date here would ask about the wrong day for a red-eye landing at
 * 00:30, which is a large share of the airport work this exists for.
 */
export function dateOnly(instant: Date): Date {
  return new Date(
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    ),
  );
}

/** `2026-09-15`, the form every provider wants in the path. */
export function dateParam(instant: Date): string {
  return dateOnly(instant).toISOString().slice(0, 10);
}

/** One lookup, cache included. Returns nothing when tracking is off. */
export async function lookupThroughCache(
  config: FlightConfig,
  flightNumber: string,
  on: Date,
): Promise<FlightResult<{ id: string } | null>> {
  const provider = providerFor(config.provider);
  const answer = await provider.lookup(config, flightNumber, dateParam(on));

  if (!answer.ok) return answer;
  if (!answer.value) {
    return {
      ok: true,
      value: await recordMiss(flightNumber, on, config.provider),
    };
  }

  return {
    ok: true,
    value: await recordFlight(answer.value, on, config.provider, null),
  };
}
