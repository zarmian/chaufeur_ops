import { cache } from 'react';
import { prisma } from './prisma';
import {
  DEFAULT_CRITICAL_DAYS,
  DEFAULT_WARNING_DAYS,
  type ComplianceThresholds,
} from './compliance';

/**
 * Configuration held in the database rather than in code.
 *
 * Everything here has a working default, so a fresh install runs before
 * anyone opens Settings. Phase 3 adds branding and locale to the same store.
 *
 * Reads are memoised per request via React's `cache`, so a page rendering
 * twenty compliance badges makes one query, not twenty.
 */

export interface AppSettings {
  complianceWarningDays: number;
  complianceCriticalDays: number;
  /**
   * Minutes either side of a pickup within which a second job for the same
   * driver counts as a clash. It is a warning, not a block — an operator can
   * see that two airport runs an hour apart are fine, and the system cannot.
   */
  driverConflictBufferMinutes: number;
  /** Completed-but-unpriced count at which the dashboard tile turns red. */
  unpricedAlertThreshold: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  complianceWarningDays: DEFAULT_WARNING_DAYS,
  complianceCriticalDays: DEFAULT_CRITICAL_DAYS,
  driverConflictBufferMinutes: 90,
  unpricedAlertThreshold: 5,
};

const SETTING_KEYS: Record<keyof AppSettings, string> = {
  complianceWarningDays: 'compliance.warningDays',
  complianceCriticalDays: 'compliance.criticalDays',
  driverConflictBufferMinutes: 'jobs.driverConflictBufferMinutes',
  unpricedAlertThreshold: 'jobs.unpricedAlertThreshold',
};

function asPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * All settings, with defaults filled in.
 *
 * A missing or malformed row falls back rather than throwing: a bad value in
 * one setting must not take the whole application down.
 */
export const getSettings = cache(async (): Promise<AppSettings> => {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: Object.values(SETTING_KEYS) } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    const warning = asPositiveInt(
      byKey.get(SETTING_KEYS.complianceWarningDays),
      DEFAULT_SETTINGS.complianceWarningDays,
    );
    const critical = asPositiveInt(
      byKey.get(SETTING_KEYS.complianceCriticalDays),
      DEFAULT_SETTINGS.complianceCriticalDays,
    );

    return {
      complianceWarningDays: warning,
      // Critical must sit inside warning, or the amber band disappears and
      // every expiring document jumps straight to red.
      complianceCriticalDays: Math.min(critical, warning),
      driverConflictBufferMinutes: asPositiveInt(
        byKey.get(SETTING_KEYS.driverConflictBufferMinutes),
        DEFAULT_SETTINGS.driverConflictBufferMinutes,
      ),
      unpricedAlertThreshold: asPositiveInt(
        byKey.get(SETTING_KEYS.unpricedAlertThreshold),
        DEFAULT_SETTINGS.unpricedAlertThreshold,
      ),
    };
  } catch {
    // Before migrations run, or if the database blinks, the defaults are
    // better than an error page.
    return DEFAULT_SETTINGS;
  }
});

/** The compliance thresholds in the shape `lib/compliance.ts` expects. */
export async function getComplianceThresholds(): Promise<ComplianceThresholds> {
  const settings = await getSettings();
  return {
    warningDays: settings.complianceWarningDays,
    criticalDays: settings.complianceCriticalDays,
  };
}

export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS[key] },
    update: { value: value as number },
    create: { key: SETTING_KEYS[key], value: value as number },
  });
}
