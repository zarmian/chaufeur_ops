import { withAudit, type AuditContext } from '../audit';
import { statusFor, type InvoiceStatus } from '../invoices';
import { prisma } from '../prisma';
import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
} from '../secret-store';
import { createRevolutLink, testRevolut } from './revolut';
import { createSumUpLink, testSumUp } from './sumup';
import {
  blankGatewayConfig,
  gatewayUsable,
  type GatewayConfig,
  type GatewayEnvironment,
  type GatewayName,
  type GatewayResult,
  type IncomingPayment,
  type PaymentLink,
} from './types';

/**
 * Gateway credentials, and the payments they send back.
 *
 * Credentials are stored per install, encrypted (see `lib/secret-store.ts`).
 * They are never returned to a browser: the settings screen is told whether a
 * key is set, not what it is.
 */

const PREFIX = 'gateway.';

export async function getGatewayConfig(
  name: GatewayName,
): Promise<GatewayConfig> {
  const row = await prisma.setting.findUnique({ where: { key: PREFIX + name } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;

  return {
    ...blankGatewayConfig(name),
    enabled: stored.enabled === true,
    environment:
      stored.environment === 'production'
        ? 'production'
        : ('sandbox' as GatewayEnvironment),
    apiKey: readSecret(stored.apiKey),
    webhookSecret: readSecret(stored.webhookSecret),
    merchantCode:
      typeof stored.merchantCode === 'string' ? stored.merchantCode : null,
  };
}

export async function getAllGatewayConfigs(): Promise<GatewayConfig[]> {
  return Promise.all([getGatewayConfig('revolut'), getGatewayConfig('sumup')]);
}

function readSecret(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return decryptSecret(value);
}

export interface GatewayInput {
  enabled: boolean;
  environment: GatewayEnvironment;
  merchantCode: string | null;
  /** Blank leaves whatever is stored alone, so saving does not wipe a key. */
  apiKey: string;
  webhookSecret: string;
}

export async function saveGatewayConfig(
  name: GatewayName,
  input: GatewayInput,
  context: AuditContext,
): Promise<GatewayResult<null>> {
  const existing = await prisma.setting.findUnique({
    where: { key: PREFIX + name },
  });
  const stored = (existing?.value ?? {}) as Record<string, unknown>;

  const wantsSecret = input.apiKey.trim() !== '' || input.webhookSecret.trim() !== '';
  if (wantsSecret && !encryptionAvailable()) {
    return {
      ok: false,
      code: 'NO_ENCRYPTION_KEY',
      message:
        'Set SETTINGS_ENCRYPTION_KEY before saving gateway credentials — generate one with `openssl rand -hex 32`. Nothing is stored in plaintext.',
    };
  }

  // Blank means "leave it": a form that cleared the key every time somebody
  // toggled the environment would be unusable, and re-pasting a secret is
  // exactly when it ends up in a chat message.
  const value = {
    enabled: input.enabled,
    environment: input.environment,
    merchantCode: input.merchantCode,
    apiKey:
      input.apiKey.trim() !== ''
        ? encryptSecret(input.apiKey.trim())
        : (stored.apiKey ?? null),
    webhookSecret:
      input.webhookSecret.trim() !== ''
        ? encryptSecret(input.webhookSecret.trim())
        : (stored.webhookSecret ?? null),
  };

  await withAudit(
    'Setting',
    'update',
    async (tx) => {
      // The audit entry records that credentials changed, never what they
      // are. A before-and-after snapshot of an API key would put it back in
      // plaintext in the one table nobody thinks to redact.
      const before = { key: PREFIX + name, secretsSet: Boolean(stored.apiKey) };
      await tx.setting.upsert({
        where: { key: PREFIX + name },
        update: { value },
        create: { key: PREFIX + name, value },
      });
      return {
        entityId: PREFIX + name,
        before,
        after: {
          key: PREFIX + name,
          enabled: value.enabled,
          environment: value.environment,
          secretsSet: Boolean(value.apiKey),
        },
        result: null,
      };
    },
    context,
  );

  return { ok: true, value: null };
}

/** Spec 4.7.2 — verify before saving, against the real provider. */
export async function testGateway(
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult<null>> {
  if (!config.apiKey) {
    return {
      ok: false,
      code: 'NO_KEY',
      message: 'Enter an API key first.',
    };
  }
  if (config.name === 'sumup' && !config.merchantCode) {
    return {
      ok: false,
      code: 'NO_MERCHANT',
      message: 'SumUp needs the merchant code as well as the key.',
    };
  }

  return config.name === 'revolut'
    ? testRevolut(config, fetchImpl)
    : testSumUp(config, fetchImpl);
}

/** Spec 4.7.3 — a link a client can pay an invoice through. */
export async function createPaymentLink(
  invoiceId: string,
  name: GatewayName,
  options: { returnUrl?: string | null } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult<PaymentLink>> {
  const [config, invoice] = await Promise.all([
    getGatewayConfig(name),
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        number: true,
        grossPence: true,
        paidPence: true,
        status: true,
        client: { select: { billingEmail: true, contactEmail: true } },
        account: { select: { billingEmail: true } },
      },
    }),
  ]);

  if (!invoice) {
    return { ok: false, code: 'NOT_FOUND', message: 'No such invoice' };
  }

  if (!gatewayUsable(config)) {
    return {
      ok: false,
      code: 'GATEWAY_OFF',
      message: `${name === 'revolut' ? 'Revolut' : 'SumUp'} is not enabled. Payments can still be recorded by hand.`,
    };
  }

  const outstanding = invoice.grossPence - invoice.paidPence;
  if (outstanding <= 0) {
    return {
      ok: false,
      code: 'NOTHING_OWED',
      message: `${invoice.number} is settled. A link for nothing would only confuse whoever received it.`,
    };
  }

  const email =
    invoice.account?.billingEmail ??
    invoice.client?.billingEmail ??
    invoice.client?.contactEmail ??
    null;

  // For the outstanding balance, not the gross: asking again for a part
  // payment already made is how a client pays twice.
  const input = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amountPence: outstanding,
    currency: 'GBP',
    customerEmail: email,
  };

  return name === 'revolut'
    ? createRevolutLink(config, input, fetchImpl)
    : createSumUpLink(
        config,
        { ...input, returnUrl: options.returnUrl ?? null },
        fetchImpl,
      );
}

export type RecordResult =
  | { ok: true; created: boolean; paymentId: string }
  | { ok: false; code: string; message: string };

/**
 * Record a payment a gateway told us about — spec 4.7.4.
 *
 * Idempotent on `gatewayTxnId`. Providers retry webhooks, sometimes for days,
 * and a handler that inserted on every delivery would credit an invoice three
 * times for one payment.
 *
 * The invoice's `paidPence` and status are recomputed in the same
 * transaction, exactly as a manual payment does, so a gateway payment and a
 * typed one leave the invoice in the same state.
 */
export async function recordGatewayPayment(
  payment: IncomingPayment,
  context: AuditContext,
): Promise<RecordResult> {
  if (payment.status !== 'received') {
    return {
      ok: false,
      code: 'NOT_SETTLED',
      message: `Ignored a ${payment.status} event — only a completed payment moves money.`,
    };
  }

  if (!payment.invoiceId) {
    return {
      ok: false,
      code: 'NO_INVOICE',
      message:
        'The payment carried no invoice reference, so there is nothing to credit it to.',
    };
  }

  const existing = await prisma.payment.findFirst({
    where: { gatewayTxnId: payment.gatewayTxnId, gateway: payment.gateway },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, created: false, paymentId: existing.id };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: payment.invoiceId },
    select: {
      id: true,
      status: true,
      grossPence: true,
      paidPence: true,
      dueDate: true,
    },
  });
  if (!invoice) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `No invoice ${payment.invoiceId} to credit.`,
    };
  }

  const created = await withAudit(
    'Invoice',
    'update',
    async (tx) => {
      const before = await tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });

      const row = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          gateway: payment.gateway,
          gatewayTxnId: payment.gatewayTxnId,
          amountPence: payment.amountPence,
          status: 'received',
          receivedAt: payment.receivedAt,
        },
        select: { id: true },
      });

      const paidPence = before.paidPence + payment.amountPence;
      const after = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidPence,
          status: statusFor(
            {
              status: before.status as InvoiceStatus,
              grossPence: before.grossPence,
              paidPence,
              dueDate: before.dueDate,
            },
            payment.receivedAt,
          ),
          paidAt: paidPence >= before.grossPence ? payment.receivedAt : null,
        },
      });

      return { entityId: invoice.id, before, after, result: row };
    },
    context,
  );

  return { ok: true, created: true, paymentId: created.id };
}

/** Spec 4.7.6 — gateway transactions with the invoice each belongs to. */
export async function listPayments(
  params: { skip: number; take: number },
  filters: { gateway?: string | null } = {},
) {
  const where = filters.gateway ? { gateway: filters.gateway } : {};

  const [rows, total, aggregate] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: params.skip,
      take: params.take,
      include: {
        invoice: {
          select: {
            id: true,
            number: true,
            grossPence: true,
            paidPence: true,
            client: { select: { name: true } },
            account: { select: { name: true } },
          },
        },
      },
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amountPence: true } }),
  ]);

  return { rows, total, totalPence: aggregate._sum.amountPence ?? 0 };
}
