import { withAudit, type AuditContext } from '../audit';
import { prisma } from '../prisma';
import { decryptSecret, encryptSecret, encryptionAvailable } from '../secret-store';
import type { BotName } from './protocol';

/**
 * Bot credentials and what the bot is allowed to do on its own.
 *
 * Tokens live encrypted in `Setting` like every other credential, and are
 * never returned to a browser — the settings screen is told a token is set,
 * not what it is. A Telegram bot token is a full account: anyone holding it
 * can read every message the bot has ever received.
 *
 * The automation toggles are separate from the tokens on purpose. Turning the
 * bot off should not mean re-entering credentials, and an operator who wants
 * assignment notices but not document chasing should not have to choose.
 */

const KEY = 'telegram';

export interface TelegramConfig {
  enabled: boolean;
  opsTokenSet: boolean;
  adminTokenSet: boolean;
  webhookSecretSet: boolean;
  /** Where ops alerts go when a group is configured. */
  dispatchChatId: string | null;
  /** Username without the @, used to build the driver link. */
  opsBotUsername: string | null;
  /** The admin bot's username, used to build the staff link — spec 5.9.1. */
  adminBotUsername: string | null;

  // Spec 5.11.3 — everything off by default. A bot that starts messaging
  // drivers the moment a token is pasted is a bot nobody trusts.
  notifyOnAssignment: boolean;
  requireAcceptance: boolean;
  chaseDocuments: boolean;
  alertUnassigned: boolean;
  requestLocation: boolean;

  /** Minutes before an unanswered assignment alerts ops — spec 5.3.5. */
  acceptanceWindowMinutes: number;
  /** Hours before pickup that an unassigned job alerts ops — spec 5.9.3. */
  unassignedAlertHours: number;
  /** Days a position ping is kept — spec 5.7.5. */
  locationRetentionDays: number;
}

export const BLANK_CONFIG: TelegramConfig = {
  enabled: false,
  opsTokenSet: false,
  adminTokenSet: false,
  webhookSecretSet: false,
  dispatchChatId: null,
  opsBotUsername: null,
  adminBotUsername: null,
  notifyOnAssignment: false,
  requireAcceptance: false,
  chaseDocuments: false,
  alertUnassigned: false,
  requestLocation: false,
  acceptanceWindowMinutes: 15,
  unassignedAlertHours: 3,
  locationRetentionDays: 30,
};

export async function getTelegramConfig(): Promise<TelegramConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;

  return {
    enabled: stored.enabled === true,
    opsTokenSet: isSet(stored.opsToken),
    adminTokenSet: isSet(stored.adminToken),
    webhookSecretSet: isSet(stored.webhookSecret) || envWebhookSecret() !== null,
    dispatchChatId: text(stored.dispatchChatId),
    opsBotUsername: text(stored.opsBotUsername),
    adminBotUsername: text(stored.adminBotUsername),
    notifyOnAssignment: stored.notifyOnAssignment === true,
    requireAcceptance: stored.requireAcceptance === true,
    chaseDocuments: stored.chaseDocuments === true,
    alertUnassigned: stored.alertUnassigned === true,
    requestLocation: stored.requestLocation === true,
    acceptanceWindowMinutes: positive(stored.acceptanceWindowMinutes, 15),
    unassignedAlertHours: positive(stored.unassignedAlertHours, 3),
    locationRetentionDays: positive(stored.locationRetentionDays, 30),
  };
}

/**
 * The token for one bot, decrypted.
 *
 * Settings first, environment second. A deployment that would rather hold
 * secrets in Vercel than in Postgres can, and the same fallback already
 * exists for email — but the settings screen is the documented path, because
 * changing a token should not need a redeploy.
 *
 * Never call this from anything that renders.
 */
export async function botToken(bot: BotName): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const field = bot === 'ops' ? stored.opsToken : stored.adminToken;

  if (typeof field === 'string' && field !== '') {
    try {
      return decryptSecret(field);
    } catch {
      // A key rotated out from under a stored secret. Falling through to the
      // environment is better than a bot that stops answering with no
      // explanation anywhere.
    }
  }

  const fromEnv =
    bot === 'ops'
      ? process.env.TELEGRAM_BOT_TOKEN
      : process.env.TELEGRAM_ADMIN_BOT_TOKEN;
  return fromEnv && fromEnv !== '' ? fromEnv : null;
}

/**
 * The secret Telegram sends back in `X-Telegram-Bot-Api-Secret-Token`.
 *
 * Environment first here, unlike the tokens: the webhook is registered once
 * at deploy time against whatever this is, and a value that could change from
 * a settings screen would silently break every future update.
 */
export async function webhookSecret(): Promise<string | null> {
  const fromEnv = envWebhookSecret();
  if (fromEnv) return fromEnv;

  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  if (typeof stored.webhookSecret === 'string' && stored.webhookSecret !== '') {
    try {
      return decryptSecret(stored.webhookSecret);
    } catch {
      return null;
    }
  }
  return null;
}

function envWebhookSecret(): string | null {
  const value = process.env.TELEGRAM_WEBHOOK_SECRET;
  return value && value !== '' ? value : null;
}

export interface TelegramInput {
  enabled: boolean;
  /** Blank leaves whatever is stored alone, so saving does not wipe a token. */
  opsToken: string;
  adminToken: string;
  webhookSecret: string;
  dispatchChatId: string;
  opsBotUsername: string;
  adminBotUsername: string;
  notifyOnAssignment: boolean;
  requireAcceptance: boolean;
  chaseDocuments: boolean;
  alertUnassigned: boolean;
  requestLocation: boolean;
  acceptanceWindowMinutes: number;
  unassignedAlertHours: number;
  locationRetentionDays: number;
}

export type TelegramResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function saveTelegramConfig(
  input: TelegramInput,
  context: AuditContext,
): Promise<TelegramResult> {
  const existing = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  const incoming = [input.opsToken, input.adminToken, input.webhookSecret].some(
    (secret) => secret.trim() !== '',
  );
  if (incoming && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving bot tokens — generate one with `openssl rand -hex 32`. A bot token is a full account, and nothing is stored in plaintext.',
    };
  }

  const opsToken = keep(input.opsToken, stored.opsToken);

  if (input.enabled && !opsToken && !process.env.TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      code: 'NO_TOKEN',
      message: 'The ops bot needs a token before it can be enabled.',
    };
  }

  const value = {
    enabled: input.enabled,
    opsToken,
    adminToken: keep(input.adminToken, stored.adminToken),
    webhookSecret: keep(input.webhookSecret, stored.webhookSecret),
    dispatchChatId: input.dispatchChatId.trim() || null,
    opsBotUsername: input.opsBotUsername.trim().replace(/^@/, '') || null,
    // The @ comes off whichever way it was typed. Somebody copying a username
    // out of Telegram brings it with them, and `t.me/@Bot` is a 404.
    adminBotUsername: input.adminBotUsername.trim().replace(/^@/, '') || null,
    notifyOnAssignment: input.notifyOnAssignment,
    requireAcceptance: input.requireAcceptance,
    chaseDocuments: input.chaseDocuments,
    alertUnassigned: input.alertUnassigned,
    requestLocation: input.requestLocation,
    acceptanceWindowMinutes: clamp(input.acceptanceWindowMinutes, 1, 240, 15),
    unassignedAlertHours: clamp(input.unassignedAlertHours, 1, 72, 3),
    locationRetentionDays: clamp(input.locationRetentionDays, 1, 365, 30),
  };

  await withAudit(
    'Setting',
    'update',
    async (tx) => {
      // Records that tokens changed, never what they are. A before-and-after
      // snapshot of a bot token would put it back in plaintext in the one
      // table nobody thinks to redact.
      const before = { key: KEY, enabled: stored.enabled, tokensSet: isSet(stored.opsToken) };
      await tx.setting.upsert({
        where: { key: KEY },
        update: { value },
        create: { key: KEY, value },
      });
      return {
        entityId: KEY,
        before,
        after: { key: KEY, enabled: value.enabled, tokensSet: isSet(value.opsToken) },
        result: null,
      };
    },
    context,
  );

  return { ok: true };
}

/** Blank means "leave it": re-pasting a secret is when it ends up in a chat. */
function keep(incoming: string, stored: unknown): string | null {
  if (incoming.trim() !== '') return encryptSecret(incoming.trim());
  return typeof stored === 'string' && stored !== '' ? stored : null;
}

function isSet(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Whether the bot should act at all.
 *
 * Checked before every outbound message rather than once at startup, so
 * turning the bot off in Settings takes effect on the next job rather than on
 * the next deploy.
 */
export async function botUsable(): Promise<boolean> {
  const config = await getTelegramConfig();
  if (!config.enabled) return false;
  return (await botToken('ops')) !== null;
}
