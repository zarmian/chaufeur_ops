import { endOfZonedDay, formatDate, formatDateTime, startOfZonedDay } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { billableClientPence } from '../job-status';
import { UNPRICED_WHERE } from '../jobs';
import { formatMoney } from '../money';
import { prisma } from '../prisma';
import { escapeMarkdown, parseStartPayload } from './protocol';
import { sendMessage } from './send';
import { redeemStaffLinkToken, unlinkStaffChat } from './staff-linking';

/**
 * The admin bot — spec 5.9.
 *
 * Read-only, deliberately. Everything here answers a question; nothing
 * changes anything. A staff member with a phone in a pub should be able to
 * see whether tomorrow is covered, and should not be able to reassign a job
 * with a fat thumb.
 *
 * Access is by Telegram chat id matched against a user account, so the role
 * table still governs who sees revenue.
 */

const MAX_ROWS = 20;

export interface AdminOutcome {
  kind: string;
  outcome: string;
}

/** The user this admin chat belongs to, if any. */
export async function userForChat(chatId: bigint) {
  return prisma.user.findFirst({
    where: { telegramChatId: chatId, active: true },
    select: { id: true, name: true, role: true },
  });
}

export async function handleAdminCommand(
  chatId: bigint,
  text: string,
): Promise<AdminOutcome> {
  /*
   * `/start stf_<token>` — the only command that works before linking, and
   * therefore the only one handled ahead of the lookup below.
   *
   * Spec 5.9.1. Everything under it needs a staff account to answer as; this
   * is how a chat acquires one.
   */
  const start = parseStartPayload(text);

  if (start?.audience === 'driver') {
    // A driver's link opened in the staff bot. Naming it saves a call to the
    // office: the two links differ only by the bot in the URL.
    await reply(
      chatId,
      escapeMarkdown(
        'That is a driver link, and this is the staff bot. Open it in the driver bot instead.',
      ),
    );
    return { kind: 'start', outcome: 'driver token in admin bot' };
  }

  if (start) {
    const outcome = await redeemStaffLinkToken(start.token, chatId);
    await reply(chatId, escapeMarkdown(outcome.message));
    return {
      kind: 'start',
      outcome: outcome.ok ? `linked ${outcome.userId}` : outcome.message,
    };
  }

  if (/^\/start\b/.test(text.trim())) {
    await reply(
      chatId,
      escapeMarkdown(
        'Hello. Open your profile in the dashboard and generate a Telegram link — it will connect this chat to your staff account.',
      ),
    );
    return { kind: 'start', outcome: 'no token' };
  }

  const user = await userForChat(chatId);

  /*
   * `/unlink` before the guard below, so it works from a chat whose account
   * has since been switched off. Somebody whose access was revoked can still
   * take their own phone out of the table; leaving a stale binding in place
   * would mean the only way to clear it is a database console.
   */
  if (/^\/unlink\b/.test(text.trim())) {
    const outcome = await unlinkStaffChat(chatId);
    await reply(chatId, escapeMarkdown(outcome.message));
    return { kind: 'unlink', outcome: outcome.ok ? 'unlinked' : outcome.message };
  }

  if (!user) {
    await sendMessage(
      chatId,
      escapeMarkdown(
        'This chat is not linked to a staff account. Open your profile in the dashboard and generate a Telegram link.',
      ),
      { bot: 'admin' },
    );
    return { kind: 'admin', outcome: 'unlinked chat' };
  }

  const [command, ...rest] = text.trim().split(/\s+/);
  const argument = rest.join(' ');
  const seesMoney = user.role === 'ADMIN' || user.role === 'ACCOUNTS';

  switch ((command ?? '').toLowerCase()) {
    case '/today':
      await reply(chatId, await dayView(0));
      return { kind: 'admin', outcome: 'today' };

    case '/tomorrow':
      await reply(chatId, await dayView(1));
      return { kind: 'admin', outcome: 'tomorrow' };

    case '/unassigned':
      await reply(chatId, await unassignedView());
      return { kind: 'admin', outcome: 'unassigned' };

    case '/unpriced':
      // The number this whole rebuild exists to keep at zero.
      await reply(chatId, await unpricedView(seesMoney));
      return { kind: 'admin', outcome: 'unpriced' };

    case '/expiring':
      await reply(chatId, await expiringView());
      return { kind: 'admin', outcome: 'expiring' };

    case '/driver':
      await reply(chatId, await driverView(argument));
      return { kind: 'admin', outcome: 'driver' };

    case '/job':
      await reply(chatId, await jobView(argument, seesMoney));
      return { kind: 'admin', outcome: 'job' };

    default:
      await reply(chatId, adminHelp());
      return { kind: 'admin', outcome: 'help' };
  }
}

async function reply(chatId: bigint, text: string): Promise<void> {
  await sendMessage(chatId, text, { bot: 'admin' });
}

async function dayView(offset: number): Promise<string> {
  const locale = await getLocaleConfig();
  const anchor = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
  const from = startOfZonedDay(anchor, locale.timeZone);
  const to = endOfZonedDay(anchor, locale.timeZone);

  const jobs = await prisma.job.findMany({
    where: {
      scheduledAt: { gte: from, lte: to },
      status: { notIn: ['CANCELLED'] },
    },
    orderBy: { scheduledAt: 'asc' },
    select: {
      reference: true,
      scheduledAt: true,
      pickupText: true,
      status: true,
      driver: { select: { name: true } },
    },
    take: MAX_ROWS,
  });

  if (jobs.length === 0) {
    return escapeMarkdown(`Nothing booked for ${formatDate(anchor, locale)}.`);
  }

  const lines = jobs.map((job) => {
    const time = formatDateTime(job.scheduledAt, locale).slice(-5);
    const who = job.driver?.name ?? '⚠️ no driver';
    return `${time} ${job.reference} — ${who} — ${job.pickupText}`;
  });

  return [
    `*${escapeMarkdown(formatDate(anchor, locale))}* — ${jobs.length} job${jobs.length === 1 ? '' : 's'}`,
    '',
    ...lines.map(escapeMarkdown),
  ].join('\n');
}

async function unassignedView(): Promise<string> {
  const locale = await getLocaleConfig();
  const jobs = await prisma.job.findMany({
    where: {
      driverId: null,
      status: { in: ['PENDING', 'DRAFT'] },
      scheduledAt: { gte: new Date() },
    },
    orderBy: { scheduledAt: 'asc' },
    select: { reference: true, scheduledAt: true, pickupText: true },
    take: MAX_ROWS,
  });

  if (jobs.length === 0) return escapeMarkdown('Everything upcoming has a driver.');

  return [
    `*${jobs.length} unassigned*`,
    '',
    ...jobs.map((job) =>
      escapeMarkdown(
        `${formatDateTime(job.scheduledAt, locale)} ${job.reference} — ${job.pickupText}`,
      ),
    ),
  ].join('\n');
}

async function unpricedView(seesMoney: boolean): Promise<string> {
  const jobs = await prisma.job.findMany({
    where: {
      // The shared definition, so this agrees with the job list, the
      // dashboard tile and the digest. Its own hand-rolled version reported
      // every as-directed job as unpriced however carefully it was quoted.
      ...UNPRICED_WHERE,
      status: { notIn: ['CANCELLED', 'DRAFT'] },
    },
    orderBy: { scheduledAt: 'desc' },
    select: { reference: true, scheduledAt: true, pickupText: true },
    take: MAX_ROWS,
  });

  if (jobs.length === 0) return escapeMarkdown('Nothing unpriced. ');

  if (!seesMoney) {
    // The count is operational; the detail is not this role's business.
    return escapeMarkdown(`${jobs.length} jobs have no price. Ask accounts.`);
  }

  const locale = await getLocaleConfig();
  return [
    `*${jobs.length} unpriced*`,
    '',
    ...jobs.map((job) =>
      escapeMarkdown(
        `${formatDate(job.scheduledAt, locale)} ${job.reference} — ${job.pickupText}`,
      ),
    ),
  ].join('\n');
}

async function expiringView(): Promise<string> {
  const locale = await getLocaleConfig();
  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const drivers = await prisma.driver.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { dvlaLicenceExpiry: { lte: horizon } },
        { phvBadgeExpiry: { lte: horizon } },
      ],
    },
    select: {
      name: true,
      dvlaLicenceExpiry: true,
      phvBadgeExpiry: true,
    },
    take: MAX_ROWS,
  });

  if (drivers.length === 0) {
    return escapeMarkdown('Nothing expiring in the next 30 days.');
  }

  const lines = drivers.flatMap((driver) => {
    const out: string[] = [];
    if (driver.dvlaLicenceExpiry && driver.dvlaLicenceExpiry <= horizon) {
      out.push(`${driver.name} — DVLA ${formatDate(driver.dvlaLicenceExpiry, locale)}`);
    }
    if (driver.phvBadgeExpiry && driver.phvBadgeExpiry <= horizon) {
      out.push(`${driver.name} — PHV ${formatDate(driver.phvBadgeExpiry, locale)}`);
    }
    return out;
  });

  return ['*Expiring within 30 days*', '', ...lines.map(escapeMarkdown)].join('\n');
}

async function driverView(name: string): Promise<string> {
  if (name.trim() === '') return escapeMarkdown('Give me a name: /driver Smith');

  const drivers = await prisma.driver.findMany({
    where: { name: { contains: name.trim(), mode: 'insensitive' }, status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      phone: true,
      telegramChatId: true,
      assignedVehicle: { select: { registration: true } },
    },
    take: 5,
  });

  if (drivers.length === 0) return escapeMarkdown(`No active driver matching “${name}”.`);

  const locale = await getLocaleConfig();

  const blocks = await Promise.all(
    drivers.map(async (driver) => {
      const next = await prisma.job.findFirst({
        where: {
          driverId: driver.id,
          scheduledAt: { gte: new Date() },
          status: { notIn: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] },
        },
        orderBy: { scheduledAt: 'asc' },
        select: { reference: true, scheduledAt: true, pickupText: true },
      });

      return [
        `*${escapeMarkdown(driver.name)}*`,
        escapeMarkdown(`${driver.phone} · ${driver.assignedVehicle?.registration ?? 'no car'}`),
        escapeMarkdown(driver.telegramChatId ? 'Telegram linked' : '⚠️ not linked'),
        escapeMarkdown(
          next
            ? `Next: ${formatDateTime(next.scheduledAt, locale)} ${next.reference} — ${next.pickupText}`
            : 'Nothing booked',
        ),
      ].join('\n');
    }),
  );

  return blocks.join('\n\n');
}

async function jobView(reference: string, seesMoney: boolean): Promise<string> {
  if (reference.trim() === '') {
    return escapeMarkdown('Give me a reference: /job JOB-000123');
  }

  const job = await prisma.job.findFirst({
    where: { reference: { contains: reference.trim(), mode: 'insensitive' } },
    select: {
      reference: true,
      scheduledAt: true,
      status: true,
      pickupText: true,
      dropoffText: true,
      clientPricePence: true,
      zeroValueReason: true,
      finance: { select: { totalClientPence: true } },
      driver: { select: { name: true, phone: true } },
      client: { select: { name: true } },
      events: {
        select: { type: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
        take: 12,
      },
    },
  });

  if (!job) return escapeMarkdown(`No job matching “${reference}”.`);

  const locale = await getLocaleConfig();
  const lines = [
    `*${escapeMarkdown(job.reference)}* — ${escapeMarkdown(job.status)}`,
    escapeMarkdown(formatDateTime(job.scheduledAt, locale)),
    escapeMarkdown(`${job.pickupText} → ${job.dropoffText}`),
    escapeMarkdown(`Client: ${job.client?.name ?? 'none recorded'}`),
    escapeMarkdown(
      job.driver ? `Driver: ${job.driver.name} (${job.driver.phone})` : '⚠️ no driver',
    ),
  ];

  if (seesMoney) {
    // Whichever home the figure lives in — a fixed fare, or hours × rate.
    const pence = billableClientPence(job);
    lines.push(
      escapeMarkdown(
        pence <= 0
          ? '⚠️ no price'
          : `Price: ${formatMoney(pence, { currency: locale.currency, locale: locale.locale })}`,
      ),
    );
  }

  if (job.events.length > 0) {
    lines.push('');
    lines.push(
      ...job.events.map((event) =>
        escapeMarkdown(
          `${formatDateTime(event.occurredAt, locale).slice(-5)} ${event.type}`,
        ),
      ),
    );
  }

  return lines.join('\n');
}

function adminHelp(): string {
  return [
    '*Commands*',
    '',
    escapeMarkdown('/today — everything booked today'),
    escapeMarkdown('/tomorrow — everything booked tomorrow'),
    escapeMarkdown('/unassigned — upcoming jobs with no driver'),
    escapeMarkdown('/unpriced — jobs with no price and no reason'),
    escapeMarkdown('/expiring — documents lapsing within 30 days'),
    escapeMarkdown('/driver Smith — a driver and their next job'),
    escapeMarkdown('/job JOB-000123 — one job and its timeline'),
    escapeMarkdown('/unlink — stop this chat answering as your account'),
  ].join('\n');
}
