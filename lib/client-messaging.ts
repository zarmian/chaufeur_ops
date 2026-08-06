import { withAudit, type AuditContext } from './audit';
import { formatDateTime } from './dates';
import { sendEmail } from './email';
import { getEmailConfig } from './email-store';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import { decryptSecret, encryptSecret, encryptionAvailable } from './secret-store';
import { DEFAULT_SMS_CONFIG, sendSms, smsConfigured, type SmsConfig } from './sms';

/**
 * Telling the client what is happening — spec 5.10.
 *
 * Everything here is opt-in per template and off by default. A system that
 * starts texting on install is a system whose first week is spent
 * apologising, and a corporate booker whose PA handles everything does not
 * want four messages a day.
 *
 * Every send is recorded whether it worked or not. Without that, "did the
 * client get the confirmation" has no answer but the client's word — which is
 * exactly the position the legacy system left everybody in.
 */

const KEY = 'client-messaging';

export type TemplateName =
  | 'booking_confirmation'
  | 'driver_assigned'
  | 'driver_en_route'
  | 'invoice'
  | 'payment_reminder';

export const TEMPLATES: Array<{ value: TemplateName; label: string; hint: string }> = [
  {
    value: 'booking_confirmation',
    label: 'Booking confirmed',
    hint: 'When a job is booked.',
  },
  {
    value: 'driver_assigned',
    label: 'Driver assigned',
    hint: 'Names the driver and the car.',
  },
  {
    value: 'driver_en_route',
    label: 'Driver on the way',
    hint: 'When the driver taps On my way.',
  },
  { value: 'invoice', label: 'Invoice sent', hint: 'Alongside the invoice email.' },
  {
    value: 'payment_reminder',
    label: 'Payment reminder',
    hint: 'When an invoice falls overdue.',
  },
];

export interface ClientMessagingConfig {
  smsProvider: SmsConfig['provider'];
  smsAccountSet: boolean;
  smsFromNumber: string | null;
  /** Per-template opt-in. Absent means off. */
  enabled: Record<TemplateName, boolean>;
}

export const BLANK_MESSAGING: ClientMessagingConfig = {
  smsProvider: 'none',
  smsAccountSet: false,
  smsFromNumber: null,
  enabled: {
    booking_confirmation: false,
    driver_assigned: false,
    driver_en_route: false,
    invoice: false,
    payment_reminder: false,
  },
};

export async function getClientMessagingConfig(): Promise<ClientMessagingConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const enabled = (stored.enabled ?? {}) as Record<string, unknown>;

  return {
    smsProvider: stored.smsProvider === 'twilio' ? 'twilio' : 'none',
    smsAccountSet:
      typeof stored.smsAccountSid === 'string' && stored.smsAccountSid !== '',
    smsFromNumber:
      typeof stored.smsFromNumber === 'string' && stored.smsFromNumber !== ''
        ? stored.smsFromNumber
        : null,
    enabled: {
      booking_confirmation: enabled.booking_confirmation === true,
      driver_assigned: enabled.driver_assigned === true,
      driver_en_route: enabled.driver_en_route === true,
      invoice: enabled.invoice === true,
      payment_reminder: enabled.payment_reminder === true,
    },
  };
}

/** The SMS credentials, decrypted. Never call this from anything that renders. */
async function smsConfig(): Promise<SmsConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;

  if (stored.smsProvider !== 'twilio') return DEFAULT_SMS_CONFIG;

  const read = (value: unknown): string | null => {
    if (typeof value !== 'string' || value === '') return null;
    try {
      return decryptSecret(value);
    } catch {
      return null;
    }
  };

  return {
    provider: 'twilio',
    accountSid: read(stored.smsAccountSid),
    authToken: read(stored.smsAuthToken),
    fromNumber:
      typeof stored.smsFromNumber === 'string' && stored.smsFromNumber !== ''
        ? stored.smsFromNumber
        : null,
  };
}

export interface MessagingInput {
  smsProvider: SmsConfig['provider'];
  /** Blank leaves what is stored alone, so saving does not wipe a credential. */
  smsAccountSid: string;
  smsAuthToken: string;
  smsFromNumber: string;
  enabled: Record<TemplateName, boolean>;
}

export type MessagingResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function saveClientMessagingConfig(
  input: MessagingInput,
  context: AuditContext,
): Promise<MessagingResult> {
  const existing = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  const incoming = input.smsAccountSid.trim() !== '' || input.smsAuthToken.trim() !== '';
  if (incoming && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving SMS credentials — generate one with `openssl rand -hex 32`. Nothing is stored in plaintext.',
    };
  }

  const keep = (incomingValue: string, current: unknown): string | null => {
    if (incomingValue.trim() !== '') return encryptSecret(incomingValue.trim());
    return typeof current === 'string' && current !== '' ? current : null;
  };

  const value = {
    smsProvider: input.smsProvider,
    smsAccountSid: keep(input.smsAccountSid, stored.smsAccountSid),
    smsAuthToken: keep(input.smsAuthToken, stored.smsAuthToken),
    smsFromNumber: input.smsFromNumber.trim() || null,
    enabled: input.enabled,
  };

  if (
    input.smsProvider === 'twilio' &&
    (!value.smsAccountSid || !value.smsAuthToken || !value.smsFromNumber)
  ) {
    return {
      ok: false,
      code: 'INCOMPLETE',
      message:
        'Twilio needs an account SID, an auth token and a from number before it can send anything.',
    };
  }

  await withAudit(
    'Setting',
    'update',
    async (tx) => {
      const before = { key: KEY, provider: stored.smsProvider };
      await tx.setting.upsert({
        where: { key: KEY },
        update: { value },
        create: { key: KEY, value },
      });
      return {
        entityId: KEY,
        before,
        after: { key: KEY, provider: value.smsProvider },
        result: null,
      };
    },
    context,
  );

  return { ok: true };
}

export interface MessageOutcome {
  attempted: number;
  sent: number;
  /** Why nothing went, when nothing did. */
  reason?: string;
}

/**
 * Tell a client something.
 *
 * Three gates before anything is sent, in order: the template must be turned
 * on, the client must not have opted out, and the channel must be configured.
 * All three are silent — this is called from job and invoice flows that must
 * succeed whether or not a message goes.
 */
export async function messageClient(
  clientId: string,
  template: TemplateName,
  content: { subject: string; body: string; sms: string },
): Promise<MessageOutcome> {
  const config = await getClientMessagingConfig();
  if (!config.enabled[template]) {
    return { attempted: 0, sent: 0, reason: 'That template is turned off' };
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      contactEmail: true,
      billingEmail: true,
      contactPhone: true,
      contactChannel: true,
    },
  });

  if (!client) return { attempted: 0, sent: 0, reason: 'No such client' };
  if (client.contactChannel === 'NONE') {
    return { attempted: 0, sent: 0, reason: 'This client asked not to be contacted' };
  }

  const wantsEmail =
    client.contactChannel === 'EMAIL' || client.contactChannel === 'BOTH';
  const wantsSms = client.contactChannel === 'SMS' || client.contactChannel === 'BOTH';

  const outcome: MessageOutcome = { attempted: 0, sent: 0 };

  if (wantsEmail) {
    const address = client.contactEmail ?? client.billingEmail;
    if (address) {
      outcome.attempted += 1;
      const emailConfig = await getEmailConfig();
      const result = await sendEmail(emailConfig, {
        to: address,
        subject: content.subject,
        html: `<p>${escapeHtml(content.body).replace(/\n/g, '<br>')}</p>`,
        text: content.body,
      });

      await record({
        clientId: client.id,
        channel: 'EMAIL',
        template,
        recipient: address,
        subject: content.subject,
        body: content.body,
        sent: result.ok,
        reason: result.ok ? 'Sent' : result.message,
        providerId: result.ok ? result.id : null,
      });

      if (result.ok) outcome.sent += 1;
    }
  }

  if (wantsSms && client.contactPhone) {
    outcome.attempted += 1;
    const config = await smsConfig();
    const result = smsConfigured(config)
      ? await sendSms(config, client.contactPhone, content.sms)
      : { sent: false as const, message: 'No SMS provider is configured' };

    await record({
      clientId: client.id,
      channel: 'SMS',
      template,
      recipient: client.contactPhone,
      subject: null,
      body: content.sms,
      sent: result.sent,
      reason: result.message,
      providerId: result.sent ? result.providerId : null,
    });

    if (result.sent) outcome.sent += 1;
  }

  if (outcome.attempted === 0) {
    return { ...outcome, reason: 'No address or number on the client record' };
  }

  return outcome;
}

/**
 * Write the message down, whether or not it went.
 *
 * Best-effort: failing to record a send must not fail the send, and failing
 * to record a failure must not fail the thing that was being reported.
 */
async function record(entry: {
  clientId: string;
  channel: 'EMAIL' | 'SMS';
  template: string;
  recipient: string;
  subject: string | null;
  body: string;
  sent: boolean;
  reason: string;
  providerId?: string | null;
}): Promise<void> {
  try {
    await prisma.clientMessage.create({
      data: {
        clientId: entry.clientId,
        channel: entry.channel,
        template: entry.template,
        recipient: entry.recipient,
        subject: entry.subject,
        body: entry.body.slice(0, 4000),
        status: entry.sent ? 'SENT' : 'FAILED',
        providerId: entry.providerId ?? null,
        failedReason: entry.sent ? null : entry.reason.slice(0, 500),
        sentAt: entry.sent ? new Date() : null,
      },
    });
  } catch {
    // Nothing to do.
  }
}

/* ------------------------------------------------------------------ *
 * The templates themselves
 * ------------------------------------------------------------------ */

export interface JobForMessage {
  reference: string;
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  driverName?: string | null;
  vehicle?: string | null;
  driverPhone?: string | null;
}

/**
 * The wording.
 *
 * The SMS is not a truncated email. It is the one line somebody reads on a
 * lock screen, so it leads with what they need — when and where — and carries
 * the reference in case they ring.
 */
export async function bookingConfirmation(job: JobForMessage, company: string) {
  const when = await formatWhen(job.scheduledAt);
  return {
    subject: `${company}: your car is booked for ${when}`,
    body: [
      `Your car is booked for ${when}.`,
      '',
      `Pickup: ${job.pickupText}`,
      `Destination: ${job.dropoffText}`,
      `Reference: ${job.reference}`,
      '',
      'Reply to this message if anything needs changing.',
    ].join('\n'),
    sms: `${company}: car booked ${when}, ${job.pickupText}. Ref ${job.reference}.`,
  };
}

export async function driverAssigned(job: JobForMessage, company: string) {
  const when = await formatWhen(job.scheduledAt);
  const who = job.driverName ?? 'Your driver';
  const car = job.vehicle ? ` in a ${job.vehicle}` : '';

  return {
    subject: `${company}: your driver for ${when}`,
    body: [
      `${who} will collect you at ${when} from ${job.pickupText}${car}.`,
      job.driverPhone ? `You can reach them on ${job.driverPhone}.` : '',
      '',
      `Reference: ${job.reference}`,
    ]
      .filter(Boolean)
      .join('\n'),
    sms: `${company}: ${who}${car} collecting you at ${when}.${job.driverPhone ? ` Driver: ${job.driverPhone}.` : ''}`,
  };
}

export async function driverEnRoute(job: JobForMessage, company: string) {
  const who = job.driverName ?? 'Your driver';
  return {
    subject: `${company}: your driver is on the way`,
    body: `${who} is on the way to ${job.pickupText}. Reference ${job.reference}.`,
    sms: `${company}: ${who} is on the way to ${job.pickupText}.`,
  };
}

async function formatWhen(instant: Date): Promise<string> {
  const locale = await getLocaleConfig();
  return formatDateTime(instant, {
    locale: locale.locale,
    timeZone: locale.timeZone,
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
