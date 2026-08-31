import { rawPrismaClient } from '../raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUserActive } from '../users';
import { handleAdminCommand } from './admin';
import {
  createStaffLinkToken,
  redeemStaffLinkToken,
  unlinkStaffChat,
  unlinkStaffUser,
} from './staff-linking';

/**
 * Staff binding their own Telegram to the admin bot — spec 5.9.1.
 *
 * The shape of a `/start` payload is settled without a database in
 * `protocol.test.ts`. What only this can prove is the part the token exists
 * for: that a link binds exactly one account, that the wrong kind of chat is
 * turned away, and that switching an account off takes its phone with it.
 *
 * That last one is the reason this file is worth its runtime. The admin bot
 * answers `/today`, `/unpriced` and `/job` — for an ADMIN or ACCOUNTS user
 * that includes revenue — and the person it stops answering for is usually
 * somebody who has just left. A binding that outlives the account is a phone
 * in a leaver's pocket still reading the day's takings.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/** Well outside anything a real chat id would be, and unique per run. */
let nextChat = 0;
function chatId(): bigint {
  nextChat += 1;
  return BigInt(`88${stamp}${nextChat}`);
}

describe.skipIf(!DATABASE_AVAILABLE)('staff telegram links', () => {
  const userIds: string[] = [];
  const driverIds: string[] = [];

  async function makeUser(
    input: { role?: string; active?: boolean } = {},
  ): Promise<string> {
    if (!raw) throw new Error('no database');
    const user = await raw.user.create({
      data: {
        email: `staff-${stamp}-${userIds.length}@example.test`,
        name: `Staff ${stamp} ${userIds.length}`,
        passwordHash: 'not-a-real-hash',
        role: (input.role ?? 'OPS') as never,
        active: input.active ?? true,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.staffLinkToken.deleteMany({ where: { userId: { in: userIds } } });
    await raw.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await raw.auditLog.deleteMany({
      where: { entity: 'User', entityId: { in: userIds } },
    });
    await raw.session.deleteMany({ where: { userId: { in: userIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.driver.deleteMany({ where: { id: { in: driverIds } } });
    await raw.$disconnect();
  });

  it('mints a link for an active account', async () => {
    const userId = await makeUser();
    const result = await createStaffLinkToken(userId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 24 bytes, base64url. The URL is the whole credential, so guessing has
    // to be hopeless rather than merely unlikely.
    expect(result.token.length).toBeGreaterThanOrEqual(30);
  });

  it('spends an outstanding link when a new one is issued', async () => {
    /*
     * Two live links means the one on screen is not necessarily the one that
     * gets redeemed, and "it says already used" is then unanswerable.
     */
    const userId = await makeUser();
    const first = await createStaffLinkToken(userId);
    const second = await createStaffLinkToken(userId);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.token).not.toBe(first.token);
    expect((await redeemStaffLinkToken(first.token, chatId())).ok).toBe(false);
    expect((await redeemStaffLinkToken(second.token, chatId())).ok).toBe(true);
  });

  it('refuses to mint one for a deactivated account', async () => {
    const userId = await makeUser({ active: false });
    const result = await createStaffLinkToken(userId);
    expect(result.ok).toBe(false);
  });

  it('binds the chat to that account and no other', async () => {
    const mine = await makeUser();
    const other = await makeUser();
    const chat = chatId();

    const link = await createStaffLinkToken(mine);
    expect(link.ok).toBe(true);
    if (!link.ok) return;

    const outcome = await redeemStaffLinkToken(link.token, chat);
    expect(outcome.ok).toBe(true);
    expect(outcome.userId).toBe(mine);

    const bound = await raw!.user.findUnique({
      where: { id: mine },
      select: { telegramChatId: true, telegramLinkedAt: true },
    });
    expect(bound?.telegramChatId).toBe(chat);
    expect(bound?.telegramLinkedAt).not.toBeNull();

    const untouched = await raw!.user.findUnique({
      where: { id: other },
      select: { telegramChatId: true },
    });
    expect(untouched?.telegramChatId).toBeNull();
  });

  it('works only once', async () => {
    const userId = await makeUser();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');

    expect((await redeemStaffLinkToken(link.token, chatId())).ok).toBe(true);
    expect((await redeemStaffLinkToken(link.token, chatId())).ok).toBe(false);
  });

  it('refuses a chat already bound to another staff account', async () => {
    /*
     * Two accounts on one chat would leave the bot answering as whichever row
     * the lookup happened to find — so a VIEWER's phone could start returning
     * an ACCOUNTS user's revenue figures.
     */
    const first = await makeUser();
    const second = await makeUser();
    const chat = chatId();

    const one = await createStaffLinkToken(first);
    if (!one.ok) throw new Error('no link');
    expect((await redeemStaffLinkToken(one.token, chat)).ok).toBe(true);

    const two = await createStaffLinkToken(second);
    if (!two.ok) throw new Error('no link');
    const outcome = await redeemStaffLinkToken(two.token, chat);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('already linked');
  });

  it('refuses a chat that belongs to a driver', async () => {
    const chat = chatId();
    const driver = await raw!.driver.create({
      data: {
        reference: `DRV-${stamp}`,
        name: `Owner Driver ${stamp}`,
        phone: `0700${stamp}`,
        status: 'ACTIVE',
        telegramChatId: chat,
      },
    });
    driverIds.push(driver.id);

    const userId = await makeUser();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');

    const outcome = await redeemStaffLinkToken(link.token, chat);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('driver record');
  });

  it('lets somebody unlink their own chat', async () => {
    const userId = await makeUser();
    const chat = chatId();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');
    await redeemStaffLinkToken(link.token, chat);

    const outcome = await unlinkStaffChat(chat);
    expect(outcome.ok).toBe(true);

    const after = await raw!.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true, telegramLinkedAt: true },
    });
    expect(after?.telegramChatId).toBeNull();
    expect(after?.telegramLinkedAt).toBeNull();
  });

  it('lets an administrator revoke somebody else’s', async () => {
    // The case that matters: a phone that has left the building with somebody
    // who has not come back.
    const userId = await makeUser();
    const chat = chatId();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');
    await redeemStaffLinkToken(link.token, chat);

    expect((await unlinkStaffUser(userId)).ok).toBe(true);

    const after = await raw!.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    expect(after?.telegramChatId).toBeNull();
  });

  it('kills a link that was issued and not yet used when the account is switched off', async () => {
    /*
     * The reachable half of "revoking takes live links with it". Somebody
     * generates a link on Friday, is deactivated on Monday before ever
     * opening it, and the message is still sitting in their email. Tapping it
     * must not bind a phone to an account that has been switched off.
     */
    const admin = await makeUser({ role: 'ADMIN' });
    const userId = await makeUser();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');

    await setUserActive(userId, false, admin, {});

    const outcome = await redeemStaffLinkToken(link.token, chatId());
    expect(outcome.ok).toBe(false);

    const after = await raw!.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    expect(after?.telegramChatId).toBeNull();
  });

  it('unbinds the phone when the account is switched off', async () => {
    /*
     * The one that matters most. `userForChat` already filters on `active`,
     * so the bot stops answering either way — this is about what happens when
     * the account is switched back on months later, possibly for a different
     * person. A binding that survives would resume answering to a phone
     * nobody remembers granting.
     */
    const admin = await makeUser({ role: 'ADMIN' });
    const userId = await makeUser();
    const chat = chatId();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');
    await redeemStaffLinkToken(link.token, chat);

    const off = await setUserActive(userId, false, admin, {});
    expect(off.ok).toBe(true);

    const after = await raw!.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true, telegramLinkedAt: true },
    });
    expect(after?.telegramChatId).toBeNull();
    expect(after?.telegramLinkedAt).toBeNull();

    // And switching it back on does not silently restore it.
    await setUserActive(userId, true, admin, {});
    const restored = await raw!.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    expect(restored?.telegramChatId).toBeNull();
  });

  it('finds nothing behind a token somebody made up', async () => {
    expect((await redeemStaffLinkToken('not-a-real-token', chatId())).ok).toBe(false);
    expect((await redeemStaffLinkToken('', chatId())).ok).toBe(false);
  });

  it('links from the bot itself, then answers as that account', async () => {
    /*
     * End to end through the command handler, because the ordering inside it
     * is the thing that broke the feature before it existed: `/start` has to
     * be answered *ahead* of the "this chat is not linked" guard, or the only
     * command that can ever link a chat is refused for not being linked.
     */
    const userId = await makeUser();
    const chat = chatId();
    const link = await createStaffLinkToken(userId);
    if (!link.ok) throw new Error('no link');

    const started = await handleAdminCommand(chat, `/start stf_${link.token}`);
    expect(started.outcome).toBe(`linked ${userId}`);

    const today = await handleAdminCommand(chat, '/today');
    expect(today.outcome).toBe('today');

    const unlinked = await handleAdminCommand(chat, '/unlink');
    expect(unlinked.outcome).toBe('unlinked');

    const after = await handleAdminCommand(chat, '/today');
    expect(after.outcome).toBe('unlinked chat');
  });

  it('turns away a driver link opened in the staff bot', async () => {
    // The two links differ only by the bot in the URL, so somebody who taps
    // the wrong one has no way to tell that is what they did.
    const result = await handleAdminCommand(chatId(), '/start drv_abcdefgh12345678');
    expect(result.outcome).toBe('driver token in admin bot');
  });
});
