/**
 * Payment gateways, as a shape rather than an integration.
 *
 * Two providers with entirely different APIs sit behind this, and a third
 * will arrive eventually. What the rest of the system needs from any of them
 * is the same three things: prove the credentials work, produce a link a
 * client can pay through, and turn a webhook into a payment against an
 * invoice.
 *
 * Client-safe: this module imports nothing, so the settings form can use the
 * types and the option lists without dragging a server module into the
 * browser bundle.
 *
 * **Gateways are optional throughout** (spec 4.7.7). Manual payment recording
 * is the primary path and always works; nothing here is required for an
 * invoice to be raised, sent, or settled.
 */

export type GatewayName = 'revolut' | 'sumup';
export type GatewayEnvironment = 'sandbox' | 'production';

export const GATEWAYS: Array<{ value: GatewayName; label: string }> = [
  { value: 'revolut', label: 'Revolut Business' },
  { value: 'sumup', label: 'SumUp' },
];

export const ENVIRONMENTS: Array<{
  value: GatewayEnvironment;
  label: string;
}> = [
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'production', label: 'Production' },
];

export interface GatewayConfig {
  name: GatewayName;
  enabled: boolean;
  environment: GatewayEnvironment;
  /** Secret. Encrypted at rest, never returned to a browser. */
  apiKey: string | null;
  /** Secret. Used to verify webhook signatures. */
  webhookSecret: string | null;
  /** SumUp needs the merchant code on every request; Revolut does not. */
  merchantCode: string | null;
}

export function blankGatewayConfig(name: GatewayName): GatewayConfig {
  return {
    name,
    enabled: false,
    environment: 'sandbox',
    apiKey: null,
    webhookSecret: null,
    merchantCode: null,
  };
}

/** API roots, so a sandbox key can never reach production by accident. */
export const GATEWAY_HOSTS: Record<
  GatewayName,
  Record<GatewayEnvironment, string>
> = {
  revolut: {
    sandbox: 'https://sandbox-merchant.revolut.com',
    production: 'https://merchant.revolut.com',
  },
  sumup: {
    // SumUp has no separate sandbox host; a test merchant account is used
    // against the same API, which is worth stating rather than leaving
    // somebody to discover when a real card is charged.
    sandbox: 'https://api.sumup.com',
    production: 'https://api.sumup.com',
  },
};

export type GatewayResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export interface PaymentLink {
  url: string;
  /** The provider's id for the order, kept so a webhook can be matched. */
  reference: string;
  expiresAt: Date | null;
}

/**
 * A payment a webhook told us about.
 *
 * `invoiceId` is carried through the provider as metadata rather than
 * inferred from the amount: two clients paying £150.60 on the same afternoon
 * would otherwise be indistinguishable, and guessing would credit the wrong
 * invoice.
 */
export interface IncomingPayment {
  gateway: GatewayName;
  gatewayTxnId: string;
  invoiceId: string | null;
  amountPence: number;
  currency: string;
  receivedAt: Date;
  status: 'received' | 'pending' | 'failed';
}

/** Whether a gateway is configured enough to be worth calling. */
export function gatewayUsable(config: GatewayConfig): boolean {
  if (!config.enabled || !config.apiKey) return false;
  if (config.name === 'sumup' && !config.merchantCode) return false;
  return true;
}

/**
 * A warning worth showing next to a production toggle.
 *
 * Returning the text rather than a boolean so the screen states the actual
 * consequence: "production" beside a sandbox key is a configuration people
 * get wrong in exactly one direction, and it charges real cards.
 *
 * Shown whether or not the gateway is currently enabled. A warning that only
 * appeared *after* somebody turned production on would arrive one step too
 * late to be a warning.
 */
export function environmentWarning(config: GatewayConfig): string | null {
  if (config.environment === 'production') {
    return 'Production takes real money from real cards. Check the key belongs to the live account, not the test one.';
  }
  if (config.name === 'sumup') {
    return 'SumUp has no separate sandbox host — “sandbox” here means a test merchant account against the live API. Use a test account, or real cards will be charged.';
  }
  return null;
}
