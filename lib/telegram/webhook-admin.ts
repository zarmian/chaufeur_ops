import { botToken, webhookSecret } from './config';
import type { BotName } from './protocol';
import { webhookOwnership } from './webhook-owner';

/**
 * Registering a bot's webhook, from the application rather than by hand.
 *
 * Spec 5.1.4 has always asked for this — "registered at deploy time via a
 * setup script, not by hand" — and it was the one part of Phase 5 that never
 * got built. Standing an install up meant pasting a `curl` from
 * `docs/deployment.md` with a token and a URL in it, at the end of a long
 * checklist, at the point where whoever is doing it most wants to be finished.
 *
 * That matters more than tidiness, because of what the mistake costs. A
 * Telegram bot has exactly one webhook URL. Point two installs at the same
 * bot and the second registration silently steals the first company's driver
 * traffic — their drivers start accepting jobs and filing expenses into
 * another company's database, with every screen still working and nothing
 * logging a fault. A hand-typed command is where that happens.
 *
 * So: one button, the URL derived from `APP_URL` rather than typed, and the
 * ownership check run immediately afterwards so the result says whose install
 * the bot is now talking to rather than merely that Telegram said "ok".
 */

const API = 'https://api.telegram.org';

/**
 * The updates each bot is asked for.
 *
 * Narrow on purpose. Telegram sends everything by default, including chat
 * membership churn and edits nobody reads, and each one is a webhook call and
 * a row in `TelegramUpdate`. The ops bot needs messages, edited messages —
 * live location arrives as a stream of edits — and button taps. The admin bot
 * answers commands only.
 */
const ALLOWED_UPDATES: Record<BotName, string[]> = {
  ops: ['message', 'edited_message', 'callback_query'],
  admin: ['message'],
};

/** Where each bot's updates should land. */
export function webhookPathFor(bot: BotName): string {
  return bot === 'ops' ? '/api/telegram/webhook' : '/api/telegram/admin-webhook';
}

export function webhookUrlFor(bot: BotName, appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${webhookPathFor(bot)}`;
}

export type RegisterOutcome =
  | { ok: true; bot: BotName; url: string; note?: string }
  | { ok: false; bot: BotName; message: string };

export interface RegisterOptions {
  /** Injected in tests, and by the script. */
  fetchImpl?: typeof fetch;
  /** Defaults to `APP_URL`. */
  appUrl?: string | null;
}

/**
 * Point one bot at this install.
 *
 * Refuses rather than guesses when `APP_URL` is missing: a webhook registered
 * against the wrong origin is the failure this exists to prevent, and there
 * is no safe default to fall back on. `VERCEL_URL` is deliberately not used —
 * it is the deployment's own unique hostname, so registering against it would
 * bind the bot to one build rather than to the install, and the next deploy
 * would silently stop receiving updates.
 */
export async function registerWebhook(
  bot: BotName,
  options: RegisterOptions = {},
): Promise<RegisterOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? '').trim();

  if (appUrl === '') {
    return {
      ok: false,
      bot,
      message:
        'APP_URL is not set, so there is no address to register. Set it to this install’s own URL and redeploy.',
    };
  }

  let origin: string;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    return { ok: false, bot, message: `APP_URL is not a valid URL: ${appUrl}` };
  }

  // Telegram refuses a plain-http webhook outright, and would do so with a
  // message about certificates that says nothing about the cause.
  if (!origin.startsWith('https://')) {
    return {
      ok: false,
      bot,
      message: 'Telegram only delivers to https. APP_URL must be an https address.',
    };
  }

  const token = await botToken(bot);
  if (!token) {
    return { ok: false, bot, message: `No ${bot} bot token is configured.` };
  }

  const secret = await webhookSecret();
  if (!secret) {
    return {
      ok: false,
      bot,
      message:
        'No webhook secret is configured. Without one the endpoint cannot tell Telegram’s calls from anybody else’s.',
    };
  }

  const url = webhookUrlFor(bot, origin);

  try {
    const response = await fetchImpl(`${API}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ALLOWED_UPDATES[bot],
        /*
         * Anything queued at Telegram from before now is dropped.
         *
         * On a fresh install that queue belongs to whatever the bot was
         * pointed at previously, which on a reused token means another
         * company's drivers. Replaying it into this database is the exact
         * mix-up the whole checklist is trying to avoid.
         */
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await response.json()) as { ok?: boolean; description?: string };
    if (!json.ok) {
      return {
        ok: false,
        bot,
        message: json.description ?? 'Telegram refused the registration.',
      };
    }
  } catch (error) {
    return {
      ok: false,
      bot,
      message:
        error instanceof Error
          ? `Could not reach Telegram: ${error.message}`
          : 'Could not reach Telegram.',
    };
  }

  // Read it back. "ok" from `setWebhook` means Telegram accepted the call, not
  // that the bot is now this install's — and that second question is the only
  // one worth answering.
  const confirmed = await confirmWebhook(bot, { fetchImpl, appUrl: origin });
  return confirmed.ok
    ? { ok: true, bot, url, note: confirmed.note }
    : { ok: false, bot, message: confirmed.message };
}

/** Ask Telegram where this bot's updates are going, and judge the answer. */
export async function confirmWebhook(
  bot: BotName,
  options: RegisterOptions = {},
): Promise<RegisterOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? '').trim();

  const token = await botToken(bot);
  if (!token) return { ok: false, bot, message: `No ${bot} bot token is configured.` };

  let registered: string | undefined;
  try {
    const response = await fetchImpl(`${API}/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as {
      ok?: boolean;
      result?: { url?: string };
    };
    if (!json.ok || !json.result) {
      return { ok: false, bot, message: 'Telegram refused the token.' };
    }
    registered = json.result.url;
  } catch {
    return { ok: false, bot, message: 'Could not reach Telegram to confirm.' };
  }

  const ownership = webhookOwnership(registered, appUrl);
  switch (ownership.state) {
    case 'ours':
      return { ok: true, bot, url: registered ?? '' };
    case 'none':
      return { ok: false, bot, message: 'Telegram holds no webhook for this bot.' };
    case 'elsewhere':
      return {
        ok: false,
        bot,
        message: `This bot is pointed at ${ownership.registered}, not at this install. If that is another company’s address, its drivers are sending updates here — use a separate bot.`,
      };
    case 'unknown':
      return { ok: false, bot, message: ownership.reason };
  }
}

/** Both bots, skipping any that has no token. */
export async function registerConfiguredWebhooks(
  options: RegisterOptions = {},
): Promise<RegisterOutcome[]> {
  const outcomes: RegisterOutcome[] = [];
  for (const bot of ['ops', 'admin'] as const) {
    if (!(await botToken(bot))) continue;
    outcomes.push(await registerWebhook(bot, options));
  }
  return outcomes;
}
