import { prisma } from '../prisma';
import { getTelegramConfig } from './config';
import {
  activeJobFor,
  beginConversation,
  cancelExpense,
  currentConversation,
  handleExpenseAmount,
  handleReceiptPhoto,
  setExpenseKind,
} from './expenses';
import { alertOps, delayKeyboard, refreshJobMessage, sendAssignment } from './dispatch';
import { reportDelay } from './delays';
import { claimJob, closeOtherOffers } from './offers';
import {
  beginDocumentFiling,
  handleDocumentExpiry,
  setDocumentType,
} from './documents';
import { applyStep } from './driver-steps';
import { driverForChat, redeemLinkToken, unlinkChat } from './linking';
import {
  decodeCallback,
  escapeMarkdown,
  parseStartPayload,
  STEP_LABELS,
  type BotName,
} from './protocol';
import { answerCallback, logUpdate, notifyDriver, sendMessage } from './send';

/**
 * Turning an update into something that happened.
 *
 * Deliberately not a grammY `Bot` with middleware. The webhook has to answer
 * inside five seconds and must never return a non-200 for a message it has
 * already acted on — Telegram retries those, and a retried `ARRIVED` would
 * reopen a wait window that has already been billed. A plain function that
 * always resolves is easier to hold to that than a middleware stack.
 *
 * grammY's types describe the update shape, which is the part worth not
 * writing by hand.
 */

/** Only the fields any handler reads. Telegram sends a great deal more. */
export interface Update {
  update_id?: number;
  message?: TelegramMessage;
  /**
   * The same shape as `message`, because live location arrives this way.
   *
   * Sharing live location sends one `message` and then edits it, repeatedly,
   * for as long as the driver chose — every movement after the first is an
   * `edited_message`. Typed as only a chat id, this looked like an update
   * nobody needed to read, and the position that reached the database was the
   * one from when the driver set off and never moved again.
   */
  edited_message?: TelegramMessage;
  callback_query?: {
    id?: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number } };
    from?: { id?: number };
  };
}

interface TelegramMessage {
  message_id?: number;
  chat?: { id?: number };
  text?: string;
  photo?: Array<{ file_id?: string; file_size?: number }>;
  location?: { latitude?: number; longitude?: number; horizontal_accuracy?: number };
  caption?: string;
}

export interface HandleResult {
  kind: string;
  outcome: string;
}

/**
 * Handle one update.
 *
 * Never throws. The webhook's contract with Telegram is a 200, and an
 * exception escaping here would become a retry of an update that may well
 * have been applied.
 */
export async function handleUpdate(
  update: Update,
  bot: BotName = 'ops',
): Promise<HandleResult> {
  const started = Date.now();
  let result: HandleResult = { kind: 'unknown', outcome: 'ignored' };
  let chatId: bigint | null = null;
  let payload: string | null = null;

  try {
    if (update.callback_query) {
      chatId = toChatId(update.callback_query.message?.chat?.id);
      payload = update.callback_query.data ?? null;
      result = await handleCallback(update.callback_query, chatId);
    } else if (update.message) {
      chatId = toChatId(update.message.chat?.id);
      const text = update.message.text ?? update.message.caption ?? '';
      payload = text.startsWith('/') ? text.split(/\s/)[0]! : null;
      result = await handleMessage(update.message, chatId);
    } else if (update.edited_message?.location) {
      // A live location moving. Only the location is taken from an edit: a
      // driver correcting a typo in an expense amount is not a second
      // expense, and re-running a command because its message was edited is
      // how one tap becomes two.
      chatId = toChatId(update.edited_message.chat?.id);
      result = await handleMessage(
        { chat: update.edited_message.chat, location: update.edited_message.location },
        chatId,
      );
    }
  } catch (error) {
    // Logged, then swallowed. A 500 here is a retry, and a retry is a second
    // tap on a button the driver pressed once.
    result = {
      kind: result.kind,
      outcome: `error: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  const driver = chatId ? await driverForChat(chatId).catch(() => null) : null;

  await logUpdate({
    bot,
    chatId,
    kind: result.kind,
    payload,
    driverId: driver?.id ?? null,
    outcome: result.outcome,
    handledMs: Date.now() - started,
  });

  return result;
}

async function handleMessage(
  message: NonNullable<Update['message']>,
  chatId: bigint | null,
): Promise<HandleResult> {
  if (!chatId) return { kind: 'message', outcome: 'no chat id' };

  const text = (message.text ?? '').trim();

  // `/start drv_<token>` — the only command that works before linking.
  const start = parseStartPayload(text);

  /*
   * A staff link opened in the driver bot.
   *
   * It cannot be redeemed here — this bot binds driver records, and binding
   * an office phone to one would send that driver's jobs and pay to it. Worth
   * naming rather than refusing as unrecognised: the two links look identical
   * apart from the bot in the URL, and somebody who has just tapped the wrong
   * one has no way to tell that is what they did.
   */
  if (start?.audience === 'staff') {
    await sendMessage(
      chatId,
      escapeMarkdown(
        'That is a staff link, and this is the driver bot. Open it in the admin bot instead.',
      ),
    );
    return { kind: 'start', outcome: 'staff token in ops bot' };
  }

  if (start) {
    const outcome = await redeemLinkToken(start.token, chatId);
    await sendMessage(chatId, escapeMarkdown(outcome.message));
    return {
      kind: 'start',
      outcome: outcome.ok ? `linked ${outcome.driverId}` : outcome.message,
    };
  }

  if (/^\/start\b/.test(text)) {
    await sendMessage(
      chatId,
      escapeMarkdown(
        'Hello. Ask the office for your personal link and it will connect this chat to your driver record.',
      ),
    );
    return { kind: 'start', outcome: 'no token' };
  }

  const driver = await driverForChat(chatId);

  if (/^\/unlink\b/.test(text)) {
    const outcome = await unlinkChat(chatId);
    await sendMessage(chatId, escapeMarkdown(outcome.message));
    if (outcome.ok) {
      await alertOps(`${outcome.driverName} has unlinked their Telegram.`);
    }
    return { kind: 'unlink', outcome: outcome.ok ? 'unlinked' : outcome.message };
  }

  if (!driver) {
    await sendMessage(
      chatId,
      escapeMarkdown(
        'This chat is not linked to a driver. Ask the office for your link.',
      ),
    );
    return { kind: 'message', outcome: 'unlinked chat' };
  }

  if (/^\/jobs\b/.test(text) || /^\/today\b/.test(text)) {
    const summary = await todayFor(driver.id);
    await sendMessage(chatId, summary);
    return { kind: 'jobs', outcome: 'listed' };
  }

  if (/^\/document\b/.test(text) || /^\/documents\b/.test(text)) {
    await beginConversation(chatId, 'document_photo', {});
    await sendMessage(
      chatId,
      escapeMarkdown(
        'Send me a photo of the document — licence, badge, insurance, MOT or V5 — and I will file it.',
      ),
    );
    return { kind: 'document', outcome: 'awaiting photo' };
  }

  if (/^\/help\b/.test(text)) {
    await sendMessage(chatId, helpText());
    return { kind: 'help', outcome: 'sent' };
  }

  if (message.location) {
    return recordLocation(driver.id, message.location);
  }

  if (message.photo && message.photo.length > 0) {
    const waiting = await currentConversation(chatId);

    /*
     * Three ways a photo arrives, and only one of them is ambiguous.
     *
     * Asked for by `/document` — it is a document. Sent during a live job
     * with nothing pending — it is a receipt, which is what the expense flow
     * has always assumed and what drivers do most. Sent with no live job —
     * it used to be refused outright, and that refusal is precisely the dead
     * end the chasing messages walked drivers into: "send a photo of your
     * new badge" answered with "I have no live job for you".
     */
    if (waiting?.step === 'document_photo') {
      return beginDocumentFiling(chatId, driver.id, message.photo);
    }

    if (await activeJobFor(driver.id)) {
      return handleReceiptPhoto(
        chatId,
        driver.id,
        message.photo,
        message.caption ?? null,
      );
    }

    return beginDocumentFiling(chatId, driver.id, message.photo);
  }

  // Mid-conversation: a bare number after a receipt is the amount, not
  // chatter for ops. Checked before the relay, or every answer would be
  // forwarded to the office as well as recorded.
  const conversation = await currentConversation(chatId);

  if (conversation?.step === 'document_expiry' && text !== '') {
    const { fileKey, sizeBytes, type } = conversation.context as {
      fileKey?: string;
      sizeBytes?: number;
      type?: string;
    };
    if (typeof fileKey === 'string' && typeof type === 'string') {
      return handleDocumentExpiry(
        chatId,
        driver.id,
        fileKey,
        typeof sizeBytes === 'number' ? sizeBytes : 0,
        type,
        text,
      );
    }
  }

  if (conversation?.step === 'expense_amount' && text !== '') {
    const expenseId = conversation.context.expenseId;
    if (typeof expenseId === 'string') {
      return handleExpenseAmount(chatId, driver.id, text, expenseId);
    }
  }

  // Anything else goes to ops rather than into the void: a driver typing
  // "stuck in traffic on the M4" is telling somebody something useful.
  if (text !== '') {
    await alertOps(`${driver.name} says: ${text.slice(0, 300)}`);
    await sendMessage(chatId, escapeMarkdown('Passed to the office.'));
    return { kind: 'message', outcome: 'relayed to ops' };
  }

  return { kind: 'message', outcome: 'nothing to do' };
}

async function handleCallback(
  query: NonNullable<Update['callback_query']>,
  chatId: bigint | null,
): Promise<HandleResult> {
  const queryId = query.id;
  if (!queryId || !chatId) return { kind: 'callback', outcome: 'malformed' };

  const callback = decodeCallback(query.data ?? '');
  if (!callback) {
    await answerCallback(queryId, 'That button is no longer valid.');
    return { kind: 'callback', outcome: 'undecodable' };
  }

  const driver = await driverForChat(chatId);
  if (!driver) {
    await answerCallback(queryId, 'This chat is not linked to a driver.', {
      alert: true,
    });
    return { kind: 'callback', outcome: 'unlinked chat' };
  }

  if (callback.kind === 'accept' || callback.kind === 'decline') {
    return respondToOffer(callback.kind, callback.jobId, driver.id, queryId);
  }

  if (callback.kind === 'step') {
    const outcome = await applyStep(callback.jobId, callback.step, driver.id);
    await answerCallback(queryId, outcome.message, { alert: outcome.refused });

    if (!outcome.refused) await refreshJobMessage(callback.jobId);
    if (outcome.opsAlert) await alertOps(outcome.opsAlert);

    return {
      kind: 'step',
      outcome: outcome.refused
        ? `refused: ${outcome.message}`
        : `${callback.step} recorded`,
    };
  }

  if (callback.kind === 'offer-accept') {
    const outcome = await claimJob(callback.jobId, driver.id);

    // An alert, not a toast, when it did not work. A driver who has just been
    // told they have a job at 5am and in fact has not must read that, not
    // catch it out of the corner of their eye.
    await answerCallback(queryId, outcome.message, { alert: !outcome.ok });

    /*
     * The offer message stops being an offer either way.
     *
     * A live "I'll take it" button under a job that has gone will be tapped
     * again — by this driver, next time they scroll past it — and the second
     * tap turns into a phone call to the office. Editing it away costs one
     * API call and removes the whole class of confusion.
     */
    const messageId = query.message?.message_id;
    if (messageId) {
      await sendMessage(chatId, escapeMarkdown(outcome.message), {
        editMessageId: messageId,
      });
    }

    if (outcome.ok) {
      // The others first: they are holding a button for work that is now
      // being driven, and the winner can wait a beat for their brief.
      await closeOtherOffers(callback.jobId, driver.id);
      // The full brief — passenger, phone, flight, board — which the offer
      // deliberately did not carry, because it went to twenty phones.
      await sendAssignment(callback.jobId);
    }

    return {
      kind: 'offer-accept',
      outcome: outcome.ok ? 'claimed' : outcome.reason,
    };
  }

  if (callback.kind === 'late') {
    /*
     * A second keyboard rather than a question.
     *
     * Sent as its own message, not an edit of the job card: the card is the
     * thing the driver navigates from, and replacing its buttons with six
     * delay choices takes the status button away at the moment they most
     * need it.
     */
    await answerCallback(queryId, 'How far behind?');
    await sendMessage(
      chatId,
      escapeMarkdown('How late do you expect to be?'),
      { buttons: delayKeyboard(callback.jobId) },
    );
    return { kind: 'late', outcome: 'asked how late' };
  }

  if (callback.kind === 'late-eta') {
    const outcome = await reportDelay(callback.jobId, driver.id, callback.minutes);
    await answerCallback(queryId, outcome.message, { alert: !outcome.recorded });
    return { kind: 'late-eta', outcome: outcome.outcome };
  }

  if (callback.kind === 'document-type') {
    const waiting = await currentConversation(chatId);
    const { fileKey, sizeBytes } = (waiting?.context ?? {}) as {
      fileKey?: string;
      sizeBytes?: number;
    };

    if (typeof fileKey !== 'string') {
      // The conversation expired, so the photo is stored but orphaned. Say so
      // rather than filing it against a guess.
      await answerCallback(queryId, 'That has timed out — send the photo again.', {
        alert: true,
      });
      return { kind: 'document-type', outcome: 'no pending document' };
    }

    const result = await setDocumentType(
      chatId,
      driver.id,
      fileKey,
      typeof sizeBytes === 'number' ? sizeBytes : 0,
      callback.documentType,
    );
    await answerCallback(queryId, 'Noted.');
    return result;
  }

  if (callback.kind === 'expense-kind') {
    const result = await setExpenseKind(
      chatId,
      driver.id,
      callback.expenseId,
      callback.expenseKind,
    );
    await answerCallback(queryId, result.message);
    return { kind: 'expense-kind', outcome: result.outcome };
  }

  if (callback.kind === 'expense-cancel') {
    const message = await cancelExpense(chatId, driver.id, callback.expenseId);
    await answerCallback(queryId, message);
    return { kind: 'expense-cancel', outcome: 'cancelled' };
  }

  await answerCallback(queryId, 'Not something I can do yet.');
  return { kind: 'callback', outcome: 'unhandled kind' };
}

/**
 * Accept or decline — spec 5.3.3 and 5.3.4.
 *
 * A decline returns the job to the pool rather than leaving it assigned to
 * somebody who has said no. It does *not* auto-reassign: picking the next
 * driver is a judgement about who is where, and a system that guesses will
 * guess wrong at 5am.
 */
async function respondToOffer(
  kind: 'accept' | 'decline',
  jobId: string,
  driverId: string,
  queryId: string,
): Promise<HandleResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, reference: true, status: true, driverId: true },
  });

  if (!job || job.driverId !== driverId) {
    await answerCallback(queryId, 'This job is no longer yours.', { alert: true });
    return { kind, outcome: 'not assigned to this driver' };
  }

  if (job.status !== 'ASSIGNED') {
    await answerCallback(
      queryId,
      job.status === 'ACCEPTED' ? 'Already accepted.' : 'This job has moved on.',
    );
    return { kind, outcome: `status was ${job.status}` };
  }

  if (kind === 'accept') {
    await prisma.$transaction(async (tx) => {
      await tx.jobEvent.create({
        data: { jobId, type: 'ACCEPTED', actorType: 'DRIVER', actorId: driverId },
      });
      await tx.job.update({ where: { id: jobId }, data: { status: 'ACCEPTED' } });
    });

    await answerCallback(queryId, 'Accepted — thanks.');
    await refreshJobMessage(jobId);
    return { kind, outcome: 'accepted' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.jobEvent.create({
      data: { jobId, type: 'DECLINED', actorType: 'DRIVER', actorId: driverId },
    });
    await tx.job.update({
      where: { id: jobId },
      // Back to the pool, with the driver cleared. Somebody has to choose
      // who does it instead, and that somebody is not this function.
      data: { status: 'PENDING', driverId: null },
    });
  });

  await answerCallback(queryId, 'Declined. The office has been told.');
  await alertOps(`${job.reference} was declined and is back in the pool.`);
  return { kind, outcome: 'declined' };
}

/** A position ping — spec 5.7.2. Stored only while a job is live. */
async function recordLocation(
  driverId: string,
  location: NonNullable<NonNullable<Update['message']>['location']>,
): Promise<HandleResult> {
  const config = await getTelegramConfig();
  if (!config.requestLocation) {
    return { kind: 'location', outcome: 'location tracking is off' };
  }

  const lat = location.latitude;
  const lng = location.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { kind: 'location', outcome: 'malformed' };
  }

  // Attached to whatever the driver is currently on, so a ping outside a job
  // is not stored at all. Following somebody around between jobs serves no
  // operational purpose.
  const job = await prisma.job.findFirst({
    where: { driverId, status: { in: ['ACCEPTED', 'IN_PROGRESS'] } },
    orderBy: { scheduledAt: 'asc' },
    select: { id: true },
  });

  if (!job) return { kind: 'location', outcome: 'no active job' };

  await prisma.driverPosition.create({
    data: {
      driverId,
      jobId: job.id,
      lat,
      lng,
      accuracyM:
        typeof location.horizontal_accuracy === 'number'
          ? Math.round(location.horizontal_accuracy)
          : null,
    },
  });

  return { kind: 'location', outcome: `recorded against ${job.id}` };
}

/** The driver's own day, for when they want to check without ringing in. */
async function todayFor(driverId: string): Promise<string> {
  const now = new Date();
  const until = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const jobs = await prisma.job.findMany({
    where: {
      driverId,
      scheduledAt: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000), lte: until },
      status: { in: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] },
    },
    orderBy: { scheduledAt: 'asc' },
    select: { reference: true, scheduledAt: true, pickupText: true },
    take: 20,
  });

  if (jobs.length === 0) return escapeMarkdown('Nothing booked in the next 24 hours.');

  const { getLocaleConfig } = await import('../locale-store');
  const { formatDateTime } = await import('../dates');
  const locale = await getLocaleConfig();

  return jobs
    .map((job) =>
      escapeMarkdown(
        `${formatDateTime(job.scheduledAt, { locale: locale.locale, timeZone: locale.timeZone })} — ${job.reference} — ${job.pickupText}`,
      ),
    )
    .join('\n');
}

function helpText(): string {
  return [
    '*What I can do*',
    '',
    escapeMarkdown('/jobs — your next 24 hours'),
    escapeMarkdown('/unlink — disconnect this chat'),
    '',
    escapeMarkdown('Tap the buttons on a job to report where you are.'),
    escapeMarkdown('Running late opens a set of times — two taps and the office knows.'),
    escapeMarkdown('Navigate opens the pickup in your maps app.'),
    escapeMarkdown(
      'A job marked “first to accept takes it” has gone to several drivers — tap quickly, and I will tell you if somebody beat you to it.',
    ),
    escapeMarkdown('Send a photo of a receipt and I will attach it to the job.'),
    escapeMarkdown('/document — file a licence, badge, insurance, MOT or V5.'),
    escapeMarkdown('Anything else you type goes straight to the office.'),
  ].join('\n');
}

function toChatId(id: number | undefined): bigint | null {
  return typeof id === 'number' ? BigInt(id) : null;
}

/** Re-exported so the ops screens can label a step without importing protocol. */
export { STEP_LABELS };

/** Tell a driver something outside any job — used by the compliance cron. */
export async function messageDriver(driverId: string, text: string) {
  return notifyDriver(driverId, escapeMarkdown(text));
}
