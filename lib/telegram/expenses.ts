import { prisma } from '../prisma';
import { buildObjectKey, isStorageConfigured, upload } from '../storage';
import { encodeCallback, escapeMarkdown, parseAmountFromChat } from './protocol';
import { downloadFile, getFilePath, sendMessage, type InlineButton } from './send';

/**
 * Receipts, from a photo — spec 5.6.
 *
 * Telegram has no notion of a form, so a receipt takes three messages: the
 * photo, a tap for what it was, and a typed amount. The thread between them
 * lives in `TelegramConversation`, keyed by chat and expiring, so a
 * conversation abandoned yesterday cannot capture an unrelated message
 * tomorrow.
 *
 * The expense row is created on the photo rather than at the end. A driver
 * who sends a receipt and then gets a job before answering has still sent the
 * receipt, and the alternative — holding the image in limbo until the
 * conversation completes — loses exactly the receipts that are hardest to
 * chase.
 */

const CONVERSATION_MINUTES = 30;

export const EXPENSE_KINDS: Array<{ value: string; label: string }> = [
  { value: 'TOLL', label: 'Toll' },
  { value: 'PARKING', label: 'Parking' },
  { value: 'CONGESTION_CHARGE', label: 'Congestion charge' },
  { value: 'ULEZ', label: 'ULEZ' },
  { value: 'FUEL', label: 'Fuel' },
  { value: 'OTHER', label: 'Other' },
];

export interface ExpenseOutcome {
  kind: string;
  outcome: string;
}

/**
 * A photo arrived.
 *
 * The largest size Telegram offers is taken: it sends a ladder of thumbnails
 * and the smallest is unreadable, which defeats the point of keeping a
 * receipt at all.
 */
export async function handleReceiptPhoto(
  chatId: bigint,
  driverId: string,
  photo: Array<{ file_id?: string; file_size?: number }>,
  caption: string | null,
): Promise<ExpenseOutcome> {
  const job = await activeJobFor(driverId);

  if (!job) {
    // Spec 5.6.7. Told plainly rather than dropped: a receipt that vanishes
    // is how drivers stop sending them.
    await sendMessage(
      chatId,
      escapeMarkdown(
        'I have no live job for you right now, so I do not know what this belongs to. Send it again once the job starts, or give it to the office.',
      ),
    );
    return { kind: 'photo', outcome: 'no active job' };
  }

  if (!isStorageConfigured()) {
    await sendMessage(
      chatId,
      escapeMarkdown(
        'Receipt storage is not set up yet, so I cannot keep the photo. Tell the office the amount and hold on to it.',
      ),
    );
    return { kind: 'photo', outcome: 'storage not configured' };
  }

  const largest = [...photo]
    .filter((size) => size.file_id)
    .sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];

  if (!largest?.file_id) {
    return { kind: 'photo', outcome: 'no usable size' };
  }

  const path = await getFilePath(largest.file_id);
  const bytes = path ? await downloadFile(path) : null;

  if (!bytes) {
    await sendMessage(
      chatId,
      escapeMarkdown('I could not fetch that photo. Try sending it again.'),
    );
    return { kind: 'photo', outcome: 'download failed' };
  }

  const key = buildObjectKey('job', job.id, 'receipt.jpg', 'receipts');

  let stored: { key: string };
  try {
    stored = await upload(Buffer.from(bytes), key, 'image/jpeg');
  } catch (error) {
    await sendMessage(
      chatId,
      escapeMarkdown('I could not store that photo. Tell the office instead.'),
    );
    return {
      kind: 'photo',
      outcome: `upload failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  // A caption often carries the amount — drivers type "parking 4.50" without
  // being asked. Taken when it parses, which saves a round trip.
  const fromCaption = caption ? parseAmountFromChat(caption) : null;

  const expense = await prisma.jobExpense.create({
    data: {
      jobId: job.id,
      kind: 'OTHER',
      amountPence: fromCaption ?? 0,
      receiptFileKey: stored.key,
      submittedByDriverId: driverId,
      // Unapproved until ops says so — spec 5.6.6. Defaulting to recharged
      // would put an unverified figure on a client's invoice.
      rechargeToClient: false,
      borneBy: 'COMPANY',
      note: caption?.slice(0, 500) ?? null,
    },
  });

  await beginConversation(chatId, fromCaption ? 'expense_kind_only' : 'expense_kind', {
    expenseId: expense.id,
    jobId: job.id,
  });

  await sendMessage(
    chatId,
    escapeMarkdown(`Got it — ${job.reference}. What was it for?`),
    { buttons: kindKeyboard(expense.id) },
  );

  return { kind: 'photo', outcome: `expense ${expense.id} opened` };
}

/** The kind buttons, two to a row so they fit a phone. */
export function kindKeyboard(expenseId: string): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < EXPENSE_KINDS.length; i += 2) {
    rows.push(
      EXPENSE_KINDS.slice(i, i + 2).map((kind) => ({
        text: kind.label,
        callbackData: encodeCallback({
          kind: 'expense-kind',
          expenseId,
          expenseKind: kind.value,
        }),
      })),
    );
  }
  rows.push([
    {
      text: 'Cancel',
      callbackData: encodeCallback({ kind: 'expense-cancel', expenseId }),
    },
  ]);
  return rows;
}

/** The driver tapped what it was for. */
export async function setExpenseKind(
  chatId: bigint,
  driverId: string,
  expenseId: string,
  kind: string,
): Promise<{ message: string; outcome: string }> {
  const expense = await prisma.jobExpense.findUnique({
    where: { id: expenseId },
    select: { id: true, submittedByDriverId: true, amountPence: true, deletedAt: true },
  });

  if (!expense || expense.deletedAt || expense.submittedByDriverId !== driverId) {
    return { message: 'That receipt is no longer open.', outcome: 'not found' };
  }

  if (!EXPENSE_KINDS.some((option) => option.value === kind)) {
    return { message: 'I do not know that kind.', outcome: 'unknown kind' };
  }

  await prisma.jobExpense.update({ where: { id: expenseId }, data: { kind: kind as never } });

  if (expense.amountPence > 0) {
    // The caption already carried the amount, so there is nothing left to ask.
    await endConversation(chatId);
    await sendMessage(
      chatId,
      escapeMarkdown('Thanks — logged and sent to the office to approve.'),
    );
    return { message: 'Logged.', outcome: 'complete from caption' };
  }

  await beginConversation(chatId, 'expense_amount', { expenseId });
  await sendMessage(chatId, escapeMarkdown('How much was it? Just the number.'));

  return { message: 'Now the amount.', outcome: 'awaiting amount' };
}

/** A number arrived while a receipt was waiting for one. */
export async function handleExpenseAmount(
  chatId: bigint,
  driverId: string,
  text: string,
  expenseId: string,
): Promise<ExpenseOutcome> {
  const pence = parseAmountFromChat(text);

  if (pence === null) {
    // The conversation stays open, so the next message is still read as an
    // amount rather than relayed to ops as chatter.
    await sendMessage(
      chatId,
      escapeMarkdown('I could not read that as an amount. Try something like 12.50.'),
    );
    return { kind: 'expense_amount', outcome: 'unparseable' };
  }

  const expense = await prisma.jobExpense.findUnique({
    where: { id: expenseId },
    select: { id: true, submittedByDriverId: true, deletedAt: true },
  });

  if (!expense || expense.deletedAt || expense.submittedByDriverId !== driverId) {
    await endConversation(chatId);
    return { kind: 'expense_amount', outcome: 'expense gone' };
  }

  await prisma.jobExpense.update({
    where: { id: expenseId },
    data: { amountPence: pence },
  });
  await endConversation(chatId);

  await sendMessage(
    chatId,
    escapeMarkdown(
      `Thanks — ${(pence / 100).toFixed(2)} logged and sent to the office to approve.`,
    ),
  );

  return { kind: 'expense_amount', outcome: `${pence} recorded` };
}

export async function cancelExpense(
  chatId: bigint,
  driverId: string,
  expenseId: string,
): Promise<string> {
  const expense = await prisma.jobExpense.findUnique({
    where: { id: expenseId },
    select: { submittedByDriverId: true },
  });

  if (expense?.submittedByDriverId === driverId) {
    // Soft-deleted like everything else, so a receipt cancelled by mistake
    // is recoverable by ops rather than gone.
    await prisma.jobExpense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });
  }

  await endConversation(chatId);
  return 'Dropped.';
}

/* ------------------------------------------------------------------ *
 * The thread between messages
 * ------------------------------------------------------------------ */

export async function beginConversation(
  chatId: bigint,
  step: string,
  context: Record<string, unknown>,
): Promise<void> {
  const expiresAt = new Date(Date.now() + CONVERSATION_MINUTES * 60 * 1000);
  await prisma.telegramConversation.upsert({
    where: { chatId },
    update: { step, context: context as never, expiresAt },
    create: { chatId, step, context: context as never, expiresAt },
  });
}

/**
 * What this chat is in the middle of, if anything.
 *
 * An expired thread is treated as none, and deleted on the way past — so a
 * question asked yesterday does not capture today's unrelated message.
 */
export async function currentConversation(
  chatId: bigint,
): Promise<{ step: string; context: Record<string, unknown> } | null> {
  const row = await prisma.telegramConversation.findUnique({ where: { chatId } });
  if (!row) return null;

  if (row.expiresAt < new Date()) {
    await endConversation(chatId);
    return null;
  }

  return { step: row.step, context: (row.context ?? {}) as Record<string, unknown> };
}

export async function endConversation(chatId: bigint): Promise<void> {
  await prisma.telegramConversation.deleteMany({ where: { chatId } });
}

/** The job a driver is currently on, if any. */
async function activeJobFor(driverId: string) {
  return prisma.job.findFirst({
    where: { driverId, status: { in: ['ACCEPTED', 'IN_PROGRESS'] } },
    orderBy: { scheduledAt: 'asc' },
    select: { id: true, reference: true },
  });
}
