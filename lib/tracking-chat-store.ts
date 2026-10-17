import { prisma } from './prisma';
import { sendSms, smsConfigured, toE164 } from './sms';
import { normalisePhone } from './text';
import type { InboundText } from './httpsms';
import {
  routeInbound,
  smsForDriver,
  type InboundCandidate,
  type InboundUnroutable,
} from './tracking-chat-inbound';
import {
  CHAT_CLOSED_TEXT,
  chatState,
  checkMessage,
  threadOpen,
  type ChatChannel,
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

/**
 * The columns a message is read back with, in one place.
 *
 * Written out four times before this, which is three chances for one of them
 * to drift and start returning a message the page cannot render.
 */
const SHAPE = {
  id: true,
  author: true,
  body: true,
  deliveredAt: true,
  createdAt: true,
} as const;

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
    select: SHAPE,
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
      driver: { select: { telegramChatId: true, phone: true } },
    },
  });
  if (!job) return null;

  return { ...job, channel: await chatChannelFor(job.driver) };
}

/**
 * How this driver's phone would be reached, or null.
 *
 * Telegram first wherever it is linked: it is free, it threads, and the reply
 * goes through a button the driver chose to press. A text is the fallback, and
 * only where the install has a gateway configured — offering a passenger a box
 * that silently cannot send is the thing this whole predicate exists to
 * prevent.
 */
export async function chatChannelFor(
  driver: { telegramChatId: bigint | null; phone: string | null } | null,
): Promise<ChatChannel | null> {
  if (!driver) return null;
  if (driver.telegramChatId) return 'telegram';

  if (!toE164(driver.phone)) return null;
  const { smsConfig } = await import('./client-messaging');
  return smsConfigured(await smsConfig()) ? 'sms' : null;
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
    select: SHAPE,
  });

  // After the row exists, and never allowed to fail the post: a passenger
  // whose message is on the page and undelivered can see that and try again,
  // where one shown an error has no idea whether it went.
  const delivered = await relayToDriver(
    job.channel!,
    job.driverId!,
    job.id,
    job.reference,
    checked.body,
  );
  if (!delivered) {
    // Recorded with the channel it was attempted on even though it failed:
    // "never arrived on Telegram" and "never arrived by text" send somebody
    // looking in different places.
    const attempted = await prisma.jobChatMessage.update({
      where: { id: stored.id },
      data: { channel: job.channel },
      select: SHAPE,
    });
    return { ok: true, message: attempted };
  }

  const marked = await prisma.jobChatMessage.update({
    where: { id: stored.id },
    data: { deliveredAt: new Date(), channel: job.channel },
    select: SHAPE,
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

  /*
   * The thread, not the passenger's box.
   *
   * A driver who is replying has been reached by definition, so asking again
   * whether they are reachable would refuse every reply from exactly the
   * drivers this path exists for — the ones with no Telegram.
   */
  const state = threadOpen(job, now);
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
    select: SHAPE,
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
  channel: ChatChannel,
  driverId: string,
  jobId: string,
  reference: string,
  body: string,
): Promise<boolean> {
  if (channel === 'sms') return relayBySms(driverId, reference, body);

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

/**
 * The same message, to a driver who never linked the bot.
 *
 * No job id travels with it — a text has nowhere to put one — so the reply
 * has to be placed by `routeInbound` when it comes back. The reference is in
 * the body for the human, who may well have two jobs on and needs to know
 * which passenger is asking.
 */
async function relayBySms(
  driverId: string,
  reference: string,
  body: string,
): Promise<boolean> {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { phone: true },
  });
  if (!driver?.phone) return false;

  const [{ smsConfig }, { getBranding }] = await Promise.all([
    import('./client-messaging'),
    import('./branding-store'),
  ]);

  const result = await sendSms(
    await smsConfig(),
    driver.phone,
    smsForDriver({
      reference,
      passengerMessage: body,
      company: (await getBranding()).tradingName,
    }),
  );

  return result.sent;
}

/**
 * Place an inbound text on the thread it answers.
 *
 * The hard half of the SMS fallback. A Telegram reply arrives with the job in
 * the button the driver pressed; a text arrives with a phone number and some
 * words, so the thread has to be worked out — and getting it wrong puts one
 * passenger's answer on another passenger's page.
 *
 * The decision itself is `routeInbound`, which is pure and tested. This finds
 * the candidates it chooses between: the driver behind the number, and every
 * journey of theirs whose thread is open right now.
 */
export async function placeInboundText(
  text: InboundText,
  now: Date = new Date(),
): Promise<PlacedText> {
  const normalised = normalisePhone(text.from);

  const driver = normalised
    ? await prisma.driver.findFirst({
        where: { normalisedPhone: normalised },
        select: { id: true, name: true },
      })
    : null;

  if (!driver) {
    return { placed: false, reason: 'UNKNOWN_SENDER', driverName: null };
  }

  /*
   * Only journeys that are live right now.
   *
   * Filtered in the database by date and status, then by `chatState` — which
   * is the same predicate the page uses, so a text cannot land on a thread the
   * passenger is being shown as closed. A reply that arrives after a journey
   * ends has nowhere to go, and that is the right answer rather than a gap.
   */
  const recent = await prisma.job.findMany({
    where: {
      driverId: driver.id,
      status: { notIn: ['DRAFT', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] },
      scheduledAt: {
        gte: new Date(now.getTime() - 24 * 3_600_000),
        lte: new Date(now.getTime() + 24 * 3_600_000),
      },
    },
    select: {
      id: true,
      reference: true,
      status: true,
      scheduledAt: true,
      chat: {
        where: { author: 'PASSENGER' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 20,
  });

  const candidates: InboundCandidate[] = recent
    .filter(
      (job) =>
        // The thread rather than the box: this text arrived, so the question
        // is only whether the journey is still one anybody can reply about.
        threadOpen(job, now).open,
    )
    .map((job) => ({
      jobId: job.id,
      reference: job.reference,
      lastAskedAt: job.chat[0]?.createdAt ?? null,
    }));

  const route = routeInbound(candidates, { known: true });

  if (route.to === 'ops') {
    return { placed: false, reason: route.reason, driverName: driver.name };
  }

  const result = await postFromDriver(route.jobId, driver.id, text.body, now);
  if (!result.ok) {
    return { placed: false, reason: 'NO_OPEN_THREAD', driverName: driver.name };
  }

  const reference =
    candidates.find((candidate) => candidate.jobId === route.jobId)?.reference ??
    null;
  return { placed: true, jobId: route.jobId, reference, driverName: driver.name };
}

export type PlacedText =
  | { placed: true; jobId: string; reference: string | null; driverName: string }
  | {
      placed: false;
      reason: InboundUnroutable;
      driverName: string | null;
    };
