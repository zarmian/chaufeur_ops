import { randomBytes } from 'node:crypto';
import { recordAudit, type AuditContext } from '../audit';
import { prisma } from '../prisma';
import { getTelegramConfig } from './config';
import { linkPayload } from './protocol';

/**
 * Binding a Telegram chat to a driver — spec 5.2.
 *
 * A one-time token in a link, rather than asking the driver for a code. A
 * driver in a car park will not type a code correctly, and every failed
 * attempt is a phone call to ops.
 *
 * The token is single-use and dated. Not because anyone is expected to
 * attack it, but because a link forwarded to the wrong person binds their
 * phone to somebody else's jobs — including their pay.
 */

const TOKEN_BYTES = 24;
const VALID_DAYS = 7;

export type LinkResult<T = unknown> =
  | ({ ok: true; id: string } & T)
  | { ok: false; code: string; message: string };

/**
 * A fresh link for a driver.
 *
 * Any outstanding unused tokens for the same driver are spent first: two
 * live links means the one ops just sent by SMS is not necessarily the one
 * that gets used, and "it says expired" is then unanswerable.
 */
export async function createLinkToken(
  driverId: string,
  context: AuditContext = {},
): Promise<LinkResult<{ url: string | null; token: string; expiresAt: Date }>> {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, name: true, telegramChatId: true },
  });
  if (!driver) return { ok: false, code: 'NOT_FOUND', message: 'No such driver' };

  if (driver.telegramChatId !== null) {
    return {
      ok: false,
      code: 'ALREADY_LINKED',
      message: `${driver.name} is already linked. Unlink first if they have changed phone.`,
    };
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + VALID_DAYS * 24 * 60 * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.linkToken.updateMany({
      where: { driverId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.linkToken.create({ data: { token, driverId, expiresAt } });
  });

  await recordAudit('Driver', 'update', driverId, {
    after: { telegramLink: 'issued', expiresAt },
  }, context);

  const config = await getTelegramConfig();

  return {
    ok: true,
    id: driverId,
    token,
    expiresAt,
    // Null rather than a broken link when the bot's username is not
    // configured: a `https://t.me/undefined?start=...` sent by SMS to a
    // driver is worse than a screen saying what is missing.
    url: config.opsBotUsername
      ? `https://t.me/${config.opsBotUsername}?start=${linkPayload(token)}`
      : null,
  };
}

export interface LinkOutcome {
  ok: boolean;
  /** What the driver is told, in the chat. */
  message: string;
  driverId?: string;
  driverName?: string;
}

/**
 * Redeem a token against a chat.
 *
 * Every refusal says what to do next, because the driver cannot see the
 * reason and ops cannot see the attempt. "Ask ops for a new link" is a
 * complete instruction; "invalid token" is not.
 */
export async function redeemLinkToken(
  token: string,
  chatId: bigint,
): Promise<LinkOutcome> {
  const row = await prisma.linkToken.findUnique({
    where: { token },
    include: { driver: true },
  });

  if (!row) {
    return {
      ok: false,
      message:
        'That link is not one I recognise. Ask the office to send you a new one.',
    };
  }

  if (row.usedAt) {
    return {
      ok: false,
      message: 'That link has already been used. Ask the office for a new one.',
    };
  }

  if (row.expiresAt < new Date()) {
    return {
      ok: false,
      message: 'That link has expired. Ask the office for a new one.',
    };
  }

  // A chat already bound elsewhere — spec 5.2.5. Usually one driver using
  // another's link, and binding it would send one driver's jobs and pay to
  // the other's phone.
  const existing = await prisma.driver.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, name: true },
  });
  if (existing && existing.id !== row.driverId) {
    return {
      ok: false,
      message:
        'This Telegram account is already linked to another driver. Ask the office to sort it out.',
    };
  }

  if (row.driver.deletedAt || row.driver.status !== 'ACTIVE') {
    return {
      ok: false,
      message: 'That driver record is not active. Ask the office.',
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.linkToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    await tx.driver.update({
      where: { id: row.driverId },
      data: { telegramChatId: chatId, telegramLinkedAt: new Date() },
    });
  });

  await recordAudit('Driver', 'update', row.driverId, {
    after: { telegramLinked: true },
  });

  return {
    ok: true,
    driverId: row.driverId,
    driverName: row.driver.name,
    message: `Linked. Hello ${row.driver.name} — your jobs will arrive here.`,
  };
}

/**
 * Unbind a chat — spec 5.2.7.
 *
 * Available to the driver, not only to ops: somebody selling their phone
 * should not have to wait for the office to open.
 */
export async function unlinkChat(chatId: bigint): Promise<LinkOutcome> {
  const driver = await prisma.driver.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, name: true },
  });

  if (!driver) {
    return { ok: false, message: 'This account is not linked to a driver.' };
  }

  await prisma.driver.update({
    where: { id: driver.id },
    data: { telegramChatId: null, telegramLinkedAt: null },
  });

  await recordAudit('Driver', 'update', driver.id, {
    after: { telegramLinked: false, by: 'driver' },
  });

  return {
    ok: true,
    driverId: driver.id,
    driverName: driver.name,
    message:
      'Unlinked. You will not receive jobs here until you link again — ask the office for a new link.',
  };
}

/** Ops unlinking on the driver's behalf, from the dashboard. */
export async function unlinkDriver(
  driverId: string,
  context: AuditContext = {},
): Promise<LinkResult> {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, telegramChatId: true },
  });
  if (!driver) return { ok: false, code: 'NOT_FOUND', message: 'No such driver' };
  if (driver.telegramChatId === null) {
    return { ok: false, code: 'NOT_LINKED', message: 'That driver is not linked.' };
  }

  await prisma.driver.update({
    where: { id: driverId },
    data: { telegramChatId: null, telegramLinkedAt: null },
  });

  await recordAudit('Driver', 'update', driverId, {
    after: { telegramLinked: false, by: 'ops' },
  }, context);

  return { ok: true, id: driverId };
}

/** The driver this chat belongs to, or null. */
export async function driverForChat(chatId: bigint) {
  return prisma.driver.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, name: true, status: true, assignedVehicleId: true },
  });
}
