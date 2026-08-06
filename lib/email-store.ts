import { withAudit, type AuditContext } from './audit';
import {
  DEFAULT_EMAIL_CONFIG,
  type EmailConfig,
  type EmailProvider,
} from './email';
import { prisma } from './prisma';
import { decryptSecret, encryptSecret, encryptionAvailable } from './secret-store';

/**
 * Where the email provider's settings live.
 *
 * The API key is encrypted at rest like a gateway credential, and for the
 * same reason: a transactional email key can send mail as the company, which
 * is worth as much to somebody else as a payment key.
 *
 * Falls back to environment variables when nothing is configured in the
 * database. That keeps `EMAIL_API_KEY`/`EMAIL_FROM` working for a deployment
 * that would rather hold secrets in Vercel than in Postgres, without making
 * the Settings screen a lie — it shows which source is in use.
 */

const KEY = 'email.config';

export type EmailSource = 'settings' | 'environment' | 'none';

export async function getEmailConfig(): Promise<
  EmailConfig & { source: EmailSource }
> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;

  const apiKey =
    typeof stored.apiKey === 'string' && stored.apiKey !== ''
      ? decryptSecret(stored.apiKey)
      : null;

  const provider = asProvider(stored.provider);

  if (provider !== 'none' && apiKey) {
    return {
      provider,
      apiKey,
      fromAddress: asText(stored.fromAddress) ?? '',
      fromName: asText(stored.fromName),
      replyTo: asText(stored.replyTo),
      source: 'settings',
    };
  }

  const envKey = process.env.EMAIL_API_KEY?.trim();
  const envFrom = process.env.EMAIL_FROM?.trim();

  if (envKey && envFrom) {
    return {
      // The environment fallback assumes Resend unless the settings row says
      // otherwise, because that is what `EMAIL_API_KEY` was reserved for.
      provider: provider === 'none' ? 'resend' : provider,
      apiKey: envKey,
      fromAddress: envFrom,
      fromName: asText(stored.fromName),
      replyTo: asText(stored.replyTo),
      source: 'environment',
    };
  }

  return { ...DEFAULT_EMAIL_CONFIG, source: 'none' };
}

export interface EmailConfigInput {
  provider: EmailProvider;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  /** Blank leaves whatever is stored alone, so saving does not wipe the key. */
  apiKey: string;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function saveEmailConfig(
  input: EmailConfigInput,
  context: AuditContext,
): Promise<SaveResult> {
  const existing = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  if (input.apiKey.trim() !== '' && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving an API key — generate one with `openssl rand -hex 32`. Nothing is stored in plaintext.',
    };
  }

  const value = {
    provider: input.provider,
    fromAddress: input.fromAddress.trim(),
    fromName: input.fromName?.trim() || null,
    replyTo: input.replyTo?.trim() || null,
    apiKey:
      input.apiKey.trim() !== ''
        ? encryptSecret(input.apiKey.trim())
        : (stored.apiKey ?? null),
  };

  await withAudit(
    'Setting',
    'update',
    async (tx) => {
      await tx.setting.upsert({
        where: { key: KEY },
        update: { value },
        create: { key: KEY, value },
      });
      // The key itself never reaches the audit log.
      return {
        entityId: KEY,
        before: { key: KEY, secretSet: Boolean(stored.apiKey) },
        after: {
          key: KEY,
          provider: value.provider,
          fromAddress: value.fromAddress,
          secretSet: Boolean(value.apiKey),
        },
        result: null,
      };
    },
    context,
  );

  return { ok: true };
}

function asProvider(value: unknown): EmailProvider {
  return value === 'resend' || value === 'postmark' ? value : 'none';
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
