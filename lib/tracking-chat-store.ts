import { prisma } from './prisma';
import {
  CHAT_CLOSED_TEXT,
  chatState,
  checkMessage,
  type ChatClosedReason,
  type ChatState,
} from './tracking-chat';

/**
 * Carrying messages between a passenger's tracking page and a driver's phone.
 *
 * Apart from `lib/tracking-chat.ts` for the usual reason: that module decides
 * who may say what and is pure, and this one reaches Postgres and Telegram.
 *
 * The relay is deliberately one-way at a time. A passenger's message is sent
 * to the driver as an ordinary bot message with a Reply button under it; the
 * driver taps it, types, and the reply lands back on the page. Nothing here
 * holds a socket open or polls Telegram — the page refreshes itself, which it
 * was already doing to keep the ETA current.
 */

export interface ChatMessage {
  id: string;
  author: 'PASSENGER' | 'DRIVER';
  body: string;
  /** Null when the relay never reached the driver, which the page says. */
  deliveredAt: Date | null;
  createdAt: Date;
}

/**
 * The thread so far.
 *
 * Oldest first, which is how a conversation reads, and capped: a page that
 * renders an unbounded list is one a bored teenager can make expensive by
 * sending four thousand messages through the box.
 */
const THREAD_MAX = 100;

export async function threadFor(jobId: string): Promise<ChatMessage[]> {
  const rows = await prisma.jobChatMessage.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
    take: THREAD_MAX,
    select: {
      id: true,
      author: true,
      body: true,
      deliveredAt: true,
      createdAt: true,
    },
  });
  return rows;
}

/** What a job needs to answer `chatState`. */
async function chatJobFor(jobId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      status: true,
      scheduledAt: true,
      driverId: true,
      driver: { select: { telegramChatId: true } },
    },
  });
  if (!job) return null;

  return {
    ...job,
    driverReachable: Boolean(job.driver?.telegramChatId),
  };
}

export type PostResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; code: 'CLOSED'; reason: ChatClosedReason; message: string }
  | { ok: false; code: 'INVALID'; message: string };

/**
 * A passenger's message, on its way to the driver.
 *
 * Recorded first and relayed second, on purpose. A message that reached the
 * driver but is missing from the page would be a passenger repeating
 * themselves at somebody who has already answered; one recorded but not
 * delivered is visible as exactly that, and says so. Of the two ways to be
 * wrong, only the second can be seen and acted on.
 */
export async function postFromPassenger(
  jobId: string,
  raw: unknown,
  now: Date = new Date(),
): Promise<PostResult> {
  const checked = checkMessage(raw);
  if (!checked.ok) return { ok: false, code: 'INVALID', message: checked.message };

  const job = await chatJobFor(jobId);
  if (!job) {
    return { ok: false, code: 'CLOSED', reason: 'JOURNEY_OVER', message: 'This journey is over.' };
  }

  const state = chatState(job, now);
  if (!state.open) {
    return {
      ok: false,
      code: 'CLOSED',
      reason: state.reason,
      message: closedText(state),
    };
  }

  const stored = await prisma.jobChatMessage.create({
    data: { jobId, author: 'PASSENGER', body: checked.body },
    select: {
      id: true,
      author: true,
      body: true,
      deliveredAt: true,
      createdAt: true,
    },
  });

  // After the row exists, and never allowed to fail the post: a passenger
  // whose message is on the page and undelivered can see that and try again,
  // where one shown an error has no idea whether it went.
  const delivered = await relayToDriver(job.driverId!, job.id, job.reference, checked.body);
  if (!delivered) return { ok: true, message: stored };

  const marked = await prisma.jobChatMessage.update({
    where: { id: stored.id },
    data: { deliveredAt: new Date() },
    select: {
      id: true,
      author: true,
      body: true,
      deliveredAt: true,
      createdAt: true,
    },
  });
  return { ok: true, message: marked };
}

/**
 * A driver's reply, on its way to the page.
 *
 * Delivered the instant it is written: the page is the destination, so there
 * is no second hop to fail. `deliveredAt` is set for the same reason.
 */
export async function postFromDriver(
  jobId: string,
  driverId: string,
  raw: unknown,
  now: Date = new Date(),
): Promise<PostResult> {
  const checked = checkMessage(raw);
  if (!checked.ok) return { ok: false, code: 'INVALID', message: checked.message };

  const job = await chatJobFor(jobId);
  if (!job) {
    return { ok: false, code: 'CLOSED', reason: 'JOURNEY_OVER', message: 'That journey is over.' };
  }

  /*
   * The driver has to still be the one on the job.
   *
   * A reply box opened before a reassignment would otherwise let the previous
   * driver keep talking to a passenger who is now somebody else's — and the
   * passenger would have no way of telling.
   */
  if (job.driverId !== driverId) {
    return {
      ok: false,
      code: 'CLOSED',
      reason: 'NO_DRIVER',
      message: 'You are no longer on that job.',
    };
  }

  const state = chatState(job, now);
  if (!state.open) {
    return {
      ok: false,
      code: 'CLOSED',
      reason: state.reason,
      message:
        state.reason === 'JOURNEY_OVER'
          ? 'That journey is over, so the passenger can no longer see messages.'
          : closedText(state),
    };
  }

  const stored = await prisma.jobChatMessage.create({
    data: {
      jobId,
      author: 'DRIVER',
      body: checked.body,
      deliveredAt: new Date(),
    },
    select: {
      id: true,
      author: true,
      body: true,
      deliveredAt: true,
      createdAt: true,
    },
  });

  return { ok: true, message: stored };
}

function closedText(state: Extract<ChatState, { open: false }>): string {
  return CHAT_CLOSED_TEXT[state.reason];
}

/**
 * Put the passenger's words on the driver's phone.
 *
 * Returns whether it actually went, rather than throwing: an unreachable
 * driver is an ordinary outcome here — Telegram off, token rotated, a driver
 * who blocked the bot — and none of those should lose the passenger's message.
 */
async function relayToDriver(
  driverId: string,
  jobId: string,
  reference: string,
  body: string,
): Promise<boolean> {
  const { notifyDriver } = await import('./telegram/send');
  const { encodeCallback, escapeMarkdown } = await import('./telegram/protocol');

  const text = [
    `💬 *Message from your passenger*`,
    `_${escapeMarkdown(reference)}_`,
    '',
    escapeMarkdown(body),
  ].join('\n');

  const result = await notifyDriver(driverId, text, {
    buttons: [
      [
        {
          text: '↩️ Reply',
          callbackData: encodeCallback({ kind: 'chat-reply', jobId }),
        },
      ],
    ],
  });

  return result.ok;
}
