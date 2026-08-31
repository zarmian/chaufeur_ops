import { prisma } from '../prisma';
import { botToken, getTelegramConfig } from './config';
import type { BotName } from './protocol';

/**
 * Talking to Telegram.
 *
 * Over `fetch` against the Bot API rather than through grammY's client: two
 * methods are used and the failure handling matters more than the ergonomics.
 * grammY earns its place on the receiving side, where update parsing is worth
 * not writing.
 *
 * Nothing here throws. A driver's phone being unreachable, a bot token having
 * been revoked, Telegram being down — none of those should fail the operation
 * that triggered the message. Assigning a job must succeed whether or not the
 * driver's phone is on.
 */

const API = 'https://api.telegram.org';

export interface SendResult {
  ok: boolean;
  messageId?: number;
  /** Why not, for the log and for ops. */
  error?: string;
}

/**
 * A button under a message.
 *
 * Either a callback — a tap that comes back to the webhook — or a link that
 * opens in the driver's phone. Never both: Telegram rejects the entire
 * keyboard if a button carries both, and a rejected keyboard means the job
 * card fails to send rather than arriving with one button missing.
 */
export type InlineButton =
  | { text: string; callbackData: string; url?: undefined }
  | { text: string; url: string; callbackData?: undefined };

export interface SendOptions {
  bot?: BotName;
  buttons?: InlineButton[][];
  /** Edit this message rather than sending a new one — spec 5.4.5. */
  editMessageId?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Send, or edit.
 *
 * Editing rather than sending is what keeps a driver's chat readable: four
 * status taps on a job would otherwise be four more messages on top of the
 * brief, and the job they are actually driving scrolls away.
 */
export async function sendMessage(
  chatId: bigint | string,
  text: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const bot = options.bot ?? 'ops';
  const token = await botToken(bot);
  if (!token) {
    return { ok: false, error: `No ${bot} bot token configured` };
  }

  const method = options.editMessageId ? 'editMessageText' : 'sendMessage';
  const body: Record<string, unknown> = {
    chat_id: String(chatId),
    text,
    parse_mode: 'MarkdownV2',
    // A job brief with a link in the notes should not push the brief off the
    // screen behind a preview card.
    link_preview_options: { is_disabled: true },
    ...(options.editMessageId ? { message_id: options.editMessageId } : {}),
    ...(options.buttons
      ? {
          reply_markup: {
            inline_keyboard: options.buttons.map((row) =>
              row.map((button) =>
                button.url
                  ? { text: button.text, url: button.url }
                  : { text: button.text, callback_data: button.callbackData },
              ),
            ),
          },
        }
      : {}),
  };

  return call(token, method, body, options.fetchImpl);
}

/**
 * Answer a tap.
 *
 * Telegram shows a spinner on the button until this is called, so it is not
 * optional decoration — an unanswered callback leaves the driver looking at a
 * button that appears stuck.
 */
export async function answerCallback(
  callbackQueryId: string,
  text?: string,
  options: { bot?: BotName; alert?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  const token = await botToken(options.bot ?? 'ops');
  if (!token) return { ok: false, error: 'No bot token configured' };

  return call(
    token,
    'answerCallbackQuery',
    {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      // An alert for a refusal, a toast for a confirmation: a driver who
      // tapped out of order needs to read why, and one who tapped correctly
      // does not need to dismiss anything.
      ...(options.alert ? { show_alert: true } : {}),
    },
    options.fetchImpl,
  );
}

/** Fetch a file's path, so the bytes can be pulled down and stored. */
export async function getFilePath(
  fileId: string,
  options: { bot?: BotName; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const token = await botToken(options.bot ?? 'ops');
  if (!token) return null;

  const call_ = options.fetchImpl ?? fetch;
  try {
    const response = await call_(`${API}/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const json = (await response.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    return json.ok && json.result?.file_path ? json.result.file_path : null;
  } catch {
    return null;
  }
}

/** Download a file Telegram is holding. Null rather than throwing. */
export async function downloadFile(
  filePath: string,
  options: { bot?: BotName; fetchImpl?: typeof fetch } = {},
): Promise<ArrayBuffer | null> {
  const token = await botToken(options.bot ?? 'ops');
  if (!token) return null;

  const call_ = options.fetchImpl ?? fetch;
  try {
    const response = await call_(`${API}/file/bot${token}/${filePath}`);
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

async function call(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<SendResult> {
  const call_ = fetchImpl ?? fetch;

  try {
    const response = await call_(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };

    if (!json.ok) {
      // Telegram's own description — "bot was blocked by the user",
      // "chat not found" — because those need different actions and
      // "send failed" needs none anybody can take.
      return { ok: false, error: json.description ?? `Telegram returned ${response.status}` };
    }

    return { ok: true, ...(json.result?.message_id ? { messageId: json.result.message_id } : {}) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Telegram was unreachable',
    };
  }
}

/**
 * Send to a driver, if there is anywhere to send to.
 *
 * Every outbound message goes through here rather than through `sendMessage`
 * directly, so the enable toggle, the missing-link case and the log are in
 * one place instead of at every call site.
 */
export async function notifyDriver(
  driverId: string,
  text: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const config = await getTelegramConfig();
  if (!config.enabled) return { ok: false, error: 'Telegram is turned off' };

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { telegramChatId: true },
  });

  if (!driver?.telegramChatId) {
    // Spec 5.2.8. Not an error worth failing an assignment over — plenty of
    // drivers will never link — but it must be visible in dispatch.
    return { ok: false, error: 'Driver is not linked to Telegram' };
  }

  return sendMessage(driver.telegramChatId, text, options);
}

/**
 * Tell ops something happened — spec 5.9.5.
 *
 * The dispatch group where one is configured, and nothing at all where one is
 * not. Falling back to messaging every admin individually sounds helpful and
 * is how an alert channel gets muted in week one.
 */
export async function notifyOps(
  text: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const config = await getTelegramConfig();
  if (!config.enabled) return { ok: false, error: 'Telegram is turned off' };
  if (!config.dispatchChatId) {
    return { ok: false, error: 'No dispatch chat configured' };
  }

  return sendMessage(config.dispatchChatId, text, { bot: 'admin', ...options });
}

/**
 * Record what came in and what came of it — spec 5.1.7.
 *
 * Best-effort: a log write failing must not turn a handled update into a
 * failed one, because Telegram retries a non-200 and the driver's tap would
 * then be applied twice.
 */
export async function logUpdate(entry: {
  bot: BotName;
  chatId?: bigint | null;
  kind: string;
  payload?: string | null;
  driverId?: string | null;
  userId?: string | null;
  outcome: string;
  handledMs?: number;
}): Promise<void> {
  try {
    await prisma.telegramUpdate.create({
      data: {
        bot: entry.bot,
        chatId: entry.chatId ?? null,
        kind: entry.kind,
        // Trimmed, and never the whole message: a Telegram update carries
        // more about the sender than any handler needed.
        payload: entry.payload ? entry.payload.slice(0, 200) : null,
        driverId: entry.driverId ?? null,
        userId: entry.userId ?? null,
        outcome: entry.outcome.slice(0, 500),
        handledMs: entry.handledMs ?? null,
      },
    });
  } catch {
    // Nothing to do.
  }
}
