import { withAudit, type AuditContext } from '../audit';
import { prisma } from '../prisma';
import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
} from '../secret-store';
import { googleRoutesProvider } from './google';
import { straightLineProvider } from './straight-line';
import {
  describeMinutes,
  isStale,
  pointFrom,
  type Estimate,
  type EtaProvider,
  type EtaProviderName,
} from './types';

/**
 * Which provider answers, and what it said about a particular job.
 *
 * The key lives here and only here, for the reason it does in
 * `lib/places/store.ts`: a routing key in a browser is a key anybody can
 * spend, and the bill arrives regardless of who spent it.
 */

const KEY = 'eta.provider';

/** Older than this and the last known position is not evidence of anything. */
export const POSITION_MAX_AGE_MINUTES = 10;

export interface EtaConfig {
  provider: EtaProviderName;
  /** Never returned to a browser — the settings screen is told only this. */
  keySet: boolean;
  /** Assumed speed for the straight-line fallback, km/h. */
  assumedKmh: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export async function getEtaConfig(): Promise<EtaConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;

  return {
    provider: stored.provider === 'google' ? 'google' : 'straight-line',
    keySet: typeof stored.apiKey === 'string' && stored.apiKey !== '',
    assumedKmh: isNumber(stored.assumedKmh) ? stored.assumedKmh : 24,
  };
}

export interface EtaInput {
  provider: EtaProviderName;
  /** Blank leaves whatever is stored alone, so saving does not wipe a key. */
  apiKey: string;
  assumedKmh: number;
}

export type EtaResult = { ok: true } | { ok: false; code: string; message: string };

export async function saveEtaConfig(
  input: EtaInput,
  context: AuditContext,
): Promise<EtaResult> {
  const existing = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  const wantsKey = input.apiKey.trim() !== '';
  if (wantsKey && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving a Routes key — generate one with `openssl rand -hex 32`. Nothing is stored in plaintext.',
    };
  }

  const apiKey = wantsKey ? encryptSecret(input.apiKey.trim()) : (stored.apiKey ?? null);

  if (input.provider === 'google' && !apiKey) {
    return {
      ok: false,
      code: 'NO_KEY',
      message:
        'Google Routes needs a key. Paste one, or leave this on the estimate, which needs nothing.',
    };
  }

  if (!isNumber(input.assumedKmh) || input.assumedKmh < 5 || input.assumedKmh > 120) {
    return {
      ok: false,
      code: 'BAD_SPEED',
      message: 'Assumed speed should be between 5 and 120 km/h.',
    };
  }

  await withAudit(
    'Setting',
    existing ? 'update' : 'create',
    async (tx) => {
      const value = { provider: input.provider, apiKey, assumedKmh: input.assumedKmh };
      const after = await tx.setting.upsert({
        where: { key: KEY },
        create: { key: KEY, value },
        update: { value },
      });
      return { entityId: KEY, before: existing ?? undefined, after, result: null };
    },
    context,
  );

  return { ok: true };
}

/** The configured provider, or the one that always works. */
async function activeProvider(config: EtaConfig): Promise<EtaProvider> {
  const fallback = straightLineProvider({ kmh: config.assumedKmh });
  if (config.provider !== 'google') return fallback;

  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const apiKey =
    typeof stored.apiKey === 'string' ? decryptSecret(stored.apiKey) : null;

  return apiKey ? googleRoutesProvider({ apiKey }) : fallback;
}

export interface JobEta {
  estimate: Estimate;
  /** Ready to drop into a sentence: "about 15 minutes away". */
  phrase: string;
  /** When the position it was computed from was recorded. */
  positionAt: Date;
}

/**
 * How far the driver is from this job's pickup, from their last known
 * position — spec: the client-facing half of live location.
 *
 * Null rather than a guess whenever the honest answer is "we do not know":
 * no position, a position too old to mean anything, or a pickup that was
 * typed by hand and never resolved to coordinates. A silent message is
 * better than a confident wrong number, because the client acts on it.
 */
export async function etaForJob(
  jobId: string,
  now: Date = new Date(),
): Promise<JobEta | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      pickupLat: true,
      pickupLng: true,
      positions: {
        orderBy: { recordedAt: 'desc' },
        take: 1,
        select: { lat: true, lng: true, recordedAt: true },
      },
    },
  });

  const destination = pointFrom(job?.pickupLat, job?.pickupLng);
  if (!destination) return null;

  const latest = job?.positions[0];
  if (!latest) return null;
  if (isStale(latest.recordedAt, now, POSITION_MAX_AGE_MINUTES)) return null;

  const origin = pointFrom(latest.lat, latest.lng);
  if (!origin) return null;

  const config = await getEtaConfig();
  const provider = await activeProvider(config);

  const estimate =
    (await provider.estimate(origin, destination)) ??
    // The configured provider declined — timed out, rate-limited, down. The
    // straight line is not as good and is considerably better than nothing.
    (await straightLineProvider({ kmh: config.assumedKmh }).estimate(origin, destination));

  if (!estimate) return null;

  return {
    estimate,
    phrase: describeMinutes(estimate.minutes),
    positionAt: latest.recordedAt,
  };
}
