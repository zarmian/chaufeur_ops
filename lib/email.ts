/**
 * Sending transactional email.
 *
 * Over the providers' HTTP APIs rather than SMTP, and with no new dependency:
 * both are a single `POST` with a JSON body, and SMTP from a serverless
 * function is slow at best and blocked at worst.
 *
 * The provider is configuration, like everything else that makes an install
 * specific to a customer — one operator has Resend, another has Postmark, and
 * a third has neither and will keep sending invoices by hand. That last case
 * is supported on purpose: nothing here is required for the system to work.
 *
 * This module is the transport only. What to send, and to whom, is the
 * caller's business.
 */

export type EmailProvider = 'none' | 'resend' | 'postmark';

export interface EmailConfig {
  provider: EmailProvider;
  /** `Ops <billing@example.com>` or a bare address. */
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  apiKey: string | null;
}

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  provider: 'none',
  fromAddress: '',
  fromName: null,
  replyTo: null,
  apiKey: null,
};

export interface EmailAttachment {
  filename: string;
  /** Raw bytes. Base64-encoded per provider at the edge, never before. */
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export type EmailResult =
  | { ok: true; id: string | null }
  | { ok: false; code: string; message: string };

/** Whether a send would even be attempted, without attempting one. */
export function emailConfigured(config: EmailConfig): boolean {
  return (
    config.provider !== 'none' &&
    Boolean(config.apiKey) &&
    Boolean(config.fromAddress)
  );
}

/** `Ops <billing@example.com>` when a name is set, the address otherwise. */
export function fromHeader(config: EmailConfig): string {
  return config.fromName
    ? `${config.fromName} <${config.fromAddress}>`
    : config.fromAddress;
}

/**
 * Send, or say why not.
 *
 * A refusal is a value rather than an exception. Sending an invoice is one
 * step of a larger action, and an unconfigured mailbox must not take the
 * whole thing down — the invoice is still raised, and the operator is told
 * the email did not go.
 */
export async function sendEmail(
  config: EmailConfig,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailResult> {
  if (!emailConfigured(config)) {
    return {
      ok: false,
      code: 'EMAIL_NOT_CONFIGURED',
      message:
        'No email provider is configured, so nothing was sent. Set one up in Settings, or send the PDF yourself.',
    };
  }

  if (!isEmailAddress(message.to)) {
    return {
      ok: false,
      code: 'NO_RECIPIENT',
      message: `${message.to || 'That recipient'} is not an email address. Add a billing address to the client or account first.`,
    };
  }

  try {
    return config.provider === 'resend'
      ? await sendViaResend(config, message, fetchImpl)
      : await sendViaPostmark(config, message, fetchImpl);
  } catch (error) {
    return {
      ok: false,
      code: 'SEND_FAILED',
      message:
        error instanceof Error
          ? error.message.slice(0, 300)
          : 'The email provider could not be reached',
    };
  }
}

async function sendViaResend(
  config: EmailConfig,
  message: EmailMessage,
  fetchImpl: typeof fetch,
): Promise<EmailResult> {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader(config),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      ...(message.text ? { text: message.text } : {}),
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content.toString('base64'),
            })),
          }
        : {}),
    }),
  });

  return readResponse(response, (body) =>
    typeof body?.id === 'string' ? body.id : null,
  );
}

async function sendViaPostmark(
  config: EmailConfig,
  message: EmailMessage,
  fetchImpl: typeof fetch,
): Promise<EmailResult> {
  const response = await fetchImpl('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': config.apiKey ?? '',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      From: fromHeader(config),
      To: message.to,
      Subject: message.subject,
      HtmlBody: message.html,
      ...(message.text ? { TextBody: message.text } : {}),
      ...(config.replyTo ? { ReplyTo: config.replyTo } : {}),
      ...(message.attachments?.length
        ? {
            Attachments: message.attachments.map((attachment) => ({
              Name: attachment.filename,
              Content: attachment.content.toString('base64'),
              ContentType: attachment.contentType,
            })),
          }
        : {}),
    }),
  });

  return readResponse(response, (body) =>
    typeof body?.MessageID === 'string' ? body.MessageID : null,
  );
}

/**
 * One reading of a provider response.
 *
 * The message is taken from whichever field the provider used, because "the
 * request failed" without the reason is a support ticket rather than an
 * error — a rejected sender domain and an expired key look identical
 * otherwise.
 */
async function readResponse(
  response: Response,
  idFrom: (body: Record<string, unknown>) => string | null,
): Promise<EmailResult> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Some failures come back with no body at all.
  }

  if (!response.ok) {
    const message =
      firstString(body, ['message', 'Message', 'error', 'name']) ??
      `The provider refused the send (HTTP ${response.status})`;
    return { ok: false, code: 'SEND_REJECTED', message: message.slice(0, 300) };
  }

  return { ok: true, id: idFrom(body) };
}

function firstString(
  body: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/**
 * Whether a send could be attempted at all.
 *
 * Deliberately permissive — the provider is the authority on deliverability,
 * and a regular expression that rejected a valid address would be worse than
 * one that let a typo through to a bounce.
 */
export function isEmailAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Verify credentials without sending anything — spec 4.7.2's sibling.
 *
 * A "test" that sent a real email would either go to a real client or need a
 * throwaway address nobody has; both providers expose a cheap authenticated
 * read instead.
 */
export async function testEmailConnection(
  config: EmailConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailResult> {
  if (!emailConfigured(config)) {
    return {
      ok: false,
      code: 'EMAIL_NOT_CONFIGURED',
      message: 'Choose a provider, and enter an API key and a from address.',
    };
  }

  try {
    const response =
      config.provider === 'resend'
        ? await fetchImpl('https://api.resend.com/domains', {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          })
        : await fetchImpl('https://api.postmarkapp.com/server', {
            headers: {
              'X-Postmark-Server-Token': config.apiKey ?? '',
              Accept: 'application/json',
            },
          });

    if (!response.ok) {
      return {
        ok: false,
        code: 'BAD_CREDENTIALS',
        message: `The provider rejected that key (HTTP ${response.status}).`,
      };
    }

    return { ok: true, id: null };
  } catch (error) {
    return {
      ok: false,
      code: 'UNREACHABLE',
      message:
        error instanceof Error
          ? error.message.slice(0, 300)
          : 'The provider could not be reached',
    };
  }
}
