import { randomBytes } from 'node:crypto';
import { recordAudit, type AuditContext } from '../audit';
import { prisma } from '../prisma';
import { getTelegramConfig } from './config';
import { linkPayload } from './protocol';

/**
 * Binding a Telegram chat to a staff account — spec 5.9.1.
 *
 * The half of the admin bot that was never built. `User.telegramChatId` has
 * been in the schema since the bot was written and `userForChat` has been
 * reading it the whole time; nothing wrote it, so the bot answered every
 * staff member with "ask an administrator to link it" and no administrator
 * had a screen that could.
 *
 * **Staff link themselves.** Not an oversight, and the one real difference
 * from the driver flow next door. A driver has no login, so ops has to issue
 * their link and send it — which is why `createLinkToken` takes a driver id
 * and an acting user. Staff all have logins, so nobody needs to hand anybody
 * a link, and a link generated *for* somebody is a link that can be sent to
 * the wrong person. An administrator can revoke another user's link; they
 * cannot mint one.
 *
 * The token is single-use and dated for the same reason the driver's is: a
 * link forwarded to the wrong person binds their phone to somebody else's
 * account. Here that is worse than a driver's — an ADMIN or ACCOUNTS account
 * answers the commands that show revenue.
 */

const TOKEN_BYTES = 24;

/**
 * Two days rather than the driver's seven.
 *
 * A driver's link goes out by SMS and may sit unread through a week of
 * shifts. A staff link is generated on a screen the person is already looking
 * at, and used within a minute or abandoned. Nothing legitimate needs it
 * alive for a week; something illegitimate might.
 */
const VALID_HOURS = 48;

export type StaffLinkResult<T = unknown> =
  | ({ ok: true; id: string } & T)
  | { ok: false; code: string; message: string };

/**
 * A fresh link for one's own account.
 *
 * Any outstanding unused tokens for the same user are spent first — two live
 * links means the one on screen is not necessarily the one that will be
 * redeemed, and "it says already used" is then unanswerable.
 */
export async function createStaffLinkToken(
  userId: string,
  context: AuditContext = {},
): Promise<StaffLinkResult<{ url: string | null; token: string; expiresAt: Date }>> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { id: true, name: true, active: true, telegramChatId: true },
  });
  if (!user) return { ok: false, code: 'NOT_FOUND', message: 'That user no longer exists' };

  if (!user.active) {
    return {
      ok: false,
      code: 'INACTIVE',
      message: 'That account is deactivated.',
    };
  }

  if (user.telegramChatId !== null) {
    return {
      ok: false,
      code: 'ALREADY_LINKED',
      message: 'Already linked. Unlink first if you have changed phone.',
    };
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + VALID_HOURS * 60 * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.staffLinkToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.staffLinkToken.create({ data: { token, userId, expiresAt } });
  });

  await recordAudit(
    'User',
    'update',
    userId,
    { after: { telegramLink: 'issued', expiresAt } },
    context,
  );

  const config = await getTelegramConfig();

  return {
    ok: true,
    id: userId,
    token,
    expiresAt,
    // Null rather than a broken link when the admin bot's username is not
    // configured. `https://t.me/undefined?start=stf_…` looks like a link and
    // is a dead end; a screen saying what is missing can be acted on.
    url: config.adminBotUsername
      ? `https://t.me/${config.adminBotUsername}?start=${linkPayload(token, 'staff')}`
      : null,
  };
}

export interface StaffLinkOutcome {
  ok: boolean;
  /** What the staff member is told, in the chat. */
  message: string;
  userId?: string;
  userName?: string;
}

/**
 * Redeem a token against a chat.
 *
 * Every refusal says what to do next. The person cannot see why it failed and
 * nobody in the office can see that they tried.
 */
export async function redeemStaffLinkToken(
  token: string,
  chatId: bigint,
): Promise<StaffLinkOutcome> {
  const row = await prisma.staffLinkToken.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!row) {
    return {
      ok: false,
      message:
        'That link is not one I recognise. Generate a new one from your profile.',
    };
  }

  if (row.usedAt) {
    return {
      ok: false,
      message: 'That link has already been used. Generate a new one from your profile.',
    };
  }

  if (row.expiresAt < new Date()) {
    return {
      ok: false,
      message: 'That link has expired. Generate a new one from your profile.',
    };
  }

  /*
   * A chat already bound to somebody else's account.
   *
   * The staff equivalent of spec 5.2.5, and it matters more here: binding a
   * second account to one chat would leave the bot answering as whichever row
   * the lookup happened to find, so a VIEWER's phone could start answering
   * with an ACCOUNTS user's revenue figures.
   */
  const existing = await prisma.user.findFirst({
    where: { telegramChatId: chatId },
    select: { id: true },
  });
  if (existing && existing.id !== row.userId) {
    return {
      ok: false,
      message:
        'This Telegram account is already linked to another staff account. Unlink there first.',
    };
  }

  /*
   * Also refuse a chat that belongs to a driver.
   *
   * An owner-driver who also does office work would otherwise bind one phone
   * to both, and the two bots would then disagree about who is holding it.
   * Rare, and cheap to rule out.
   */
  const asDriver = await prisma.driver.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true },
  });
  if (asDriver) {
    return {
      ok: false,
      message:
        'This Telegram account is already linked to a driver record. Use a different account for staff access.',
    };
  }

  if (!row.user.active || row.user.deletedAt) {
    return { ok: false, message: 'That account is not active. Ask an administrator.' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.staffLinkToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    await tx.user.update({
      where: { id: row.userId },
      data: { telegramChatId: chatId, telegramLinkedAt: new Date() },
    });
  });

  await recordAudit('User', 'update', row.userId, {
    after: { telegramLinked: true },
  });

  return {
    ok: true,
    userId: row.userId,
    userName: row.user.name,
    message: `Linked. Hello ${row.user.name} — send /help for what I can tell you.`,
  };
}

/**
 * Unbind a chat, from the chat itself.
 *
 * Available without a dashboard, because somebody selling their phone at the
 * weekend should not have to wait until Monday.
 */
export async function unlinkStaffChat(chatId: bigint): Promise<StaffLinkOutcome> {
  const user = await prisma.user.findFirst({
    where: { telegramChatId: chatId },
    select: { id: true, name: true },
  });

  if (!user) return { ok: false, message: 'This chat is not linked to a staff account.' };

  await prisma.user.update({
    where: { id: user.id },
    data: { telegramChatId: null, telegramLinkedAt: null },
  });

  await recordAudit('User', 'update', user.id, {
    after: { telegramLinked: false, by: 'self' },
  });

  return {
    ok: true,
    userId: user.id,
    userName: user.name,
    message: 'Unlinked. This chat will not answer until you link it again.',
  };
}

/**
 * Unlink from the dashboard — one's own account, or somebody else's.
 *
 * The administrator half of the feature. Minting a link for another user is
 * deliberately not offered; revoking one is, because the case that matters is
 * a phone that has left the building with somebody who has not.
 */
export async function unlinkStaffUser(
  userId: string,
  context: AuditContext = {},
): Promise<StaffLinkResult> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { id: true, telegramChatId: true },
  });
  if (!user) return { ok: false, code: 'NOT_FOUND', message: 'That user no longer exists' };
  if (user.telegramChatId === null) {
    return { ok: false, code: 'NOT_LINKED', message: 'That account is not linked.' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { telegramChatId: null, telegramLinkedAt: null },
    });
    // Any link still in flight goes with it. Revoking the binding while
    // leaving a live token would let the same phone re-link from a message
    // still sitting in its history.
    await tx.staffLinkToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
  });

  await recordAudit(
    'User',
    'update',
    userId,
    { after: { telegramLinked: false, by: 'dashboard' } },
    context,
  );

  return { ok: true, id: userId };
}

/** Whether this user has a chat bound, for the screens. */
export async function staffTelegramStatus(userId: string) {
  return prisma.user.findFirst({
    where: { id: userId },
    select: { telegramLinkedAt: true, telegramChatId: true },
  });
}
