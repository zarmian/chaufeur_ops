import { recordAudit } from '../audit';
import { isDriverCompliantAt } from '../compliance';
import { formatDateTime } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { formatMoney } from '../money';
import { prisma } from '../prisma';
import { botUsable } from './config';
import { encodeCallback, escapeMarkdown } from './protocol';
import { sendMessage } from './send';

/**
 * One job put to several drivers at once — first to accept takes it.
 *
 * Assignment today is one driver at a time: ops picks somebody, the bot asks,
 * and if the answer is no — or no answer comes — the job goes back in the
 * pool and somebody picks again. That is the right shape for a booking with a
 * named driver and the wrong one at six in the morning with a car needed in
 * forty minutes and a fleet of nearly two hundred owner-drivers, most of whom
 * are asleep.
 *
 * The whole feature turns on one question: **what happens when two drivers
 * tap Accept at the same instant?** Everything else here is arrangement. The
 * answer is a conditional update — a single SQL statement that assigns the
 * job only while it is still unassigned — so the database decides, once,
 * rather than two reads racing each other to a write. Read-then-write would
 * hand the same job to both, and the second driver would find out at the
 * kerb.
 *
 * Compliance is re-checked at the moment of accepting and not only when the
 * offer went out. An offer can sit unanswered for hours, and a badge that
 * expires overnight would otherwise put a driver on a job they cannot legally
 * take — which is the one rule in this system that is a licensing
 * requirement rather than a preference.
 */

export interface OfferSummary {
  offered: number;
  skipped: Array<{ driverId: string; name: string; reason: string }>;
}

/** How many phones one job may ring at once, unless told otherwise. */
const DEFAULT_LIMIT = 20;

/**
 * Who could legally and practically take this job.
 *
 * Linked, active, compliant at the job's own time — not at now, because a
 * badge valid today and expired by Friday does not qualify somebody for a
 * job on Friday.
 */
export async function eligibleDrivers(
  jobId: string,
  limit = DEFAULT_LIMIT,
): Promise<{ eligible: Array<{ id: string; name: string; telegramChatId: bigint }>; skipped: OfferSummary['skipped'] }> {
  const job = await prisma.job.findFirst({
    where: { id: jobId },
    select: { id: true, scheduledAt: true, vehicleId: true },
  });
  if (!job) return { eligible: [], skipped: [] };

  const candidates = await prisma.driver.findMany({
    where: {
      status: 'ACTIVE',
      // Unlinked drivers cannot be offered anything: the offer *is* a
      // Telegram message. The dispatch view is where that shows.
      telegramChatId: { not: null },
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, telegramChatId: true, assignedVehicleId: true },
  });

  const eligible: Array<{ id: string; name: string; telegramChatId: bigint }> = [];
  const skipped: OfferSummary['skipped'] = [];

  for (const driver of candidates) {
    if (eligible.length >= limit) break;

    const verdict = await isDriverCompliantAt(driver.id, job.scheduledAt, {
      // The car they would actually bring: the job's own vehicle when it has
      // one, otherwise theirs. A job may override a driver's assigned car.
      vehicleId: job.vehicleId ?? driver.assignedVehicleId,
    });

    if (!verdict.compliant) {
      skipped.push({
        driverId: driver.id,
        name: driver.name,
        reason: verdict.reasons[0] ?? 'not compliant',
      });
      continue;
    }

    eligible.push({
      id: driver.id,
      name: driver.name,
      telegramChatId: driver.telegramChatId!,
    });
  }

  return { eligible, skipped };
}

/**
 * Put the job to them.
 *
 * Refuses a job that already has a driver: an offer for work somebody is
 * already doing is a message that can only cause a phone call.
 */
export async function offerJob(
  jobId: string,
  options: { limit?: number } = {},
): Promise<{ ok: false; message: string } | ({ ok: true } & OfferSummary)> {
  /*
   * The bot has to be on, or the office presses a button, reads "offered to
   * twelve drivers", and waits for an answer to a message nobody sent.
   *
   * `botUsable` rather than `enabled`: a token that is missing or has been
   * revoked fails exactly the same way from the operator's side, and the only
   * useful thing to say about either is "not until the bot is set up".
   */
  if (!(await botUsable())) {
    return {
      ok: false,
      message: 'The Telegram bot is not set up, so there is nowhere to send this.',
    };
  }

  const job = await prisma.job.findFirst({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      driverId: true,
      status: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      driverPricePence: true,
    },
  });

  if (!job) return { ok: false, message: 'That job no longer exists.' };
  if (job.driverId) {
    return { ok: false, message: 'That job already has a driver.' };
  }
  if (!['PENDING', 'DRAFT'].includes(job.status)) {
    return { ok: false, message: `That job is ${job.status.toLowerCase()}.` };
  }

  const { eligible, skipped } = await eligibleDrivers(jobId, options.limit);
  if (eligible.length === 0) {
    return {
      ok: false,
      message:
        skipped.length > 0
          ? `Nobody is eligible: ${skipped.length} driver${skipped.length === 1 ? '' : 's'} skipped on compliance.`
          : 'No linked, active drivers to offer it to.',
    };
  }

  const text = await offerText(job);

  for (const driver of eligible) {
    /*
     * The row before the message.
     *
     * If sending fails, an offer row with no message is a record that this
     * driver was meant to be asked and was not — visible, and fixable. The
     * other way round, a message with no row is an Accept button the system
     * does not know it sent, which cannot be withdrawn when the job goes.
     */
    const offer = await prisma.jobOffer.upsert({
      where: { jobId_driverId: { jobId, driverId: driver.id } },
      update: { closedAt: null, outcome: null, sentAt: new Date() },
      create: { jobId, driverId: driver.id },
      select: { id: true },
    });

    const sent = await sendMessage(driver.telegramChatId, text, {
      buttons: [
        [
          {
            text: '✅ I’ll take it',
            callbackData: encodeCallback({ kind: 'offer-accept', jobId }),
          },
        ],
      ],
    });

    if (sent.ok && sent.messageId) {
      await prisma.jobOffer.update({
        where: { id: offer.id },
        data: { messageId: sent.messageId },
      });
    }
  }

  return { ok: true, offered: eligible.length, skipped };
}

export type ClaimOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; reason: 'taken' | 'gone' | 'blocked' | 'not offered' };

/**
 * A driver taking the job.
 *
 * The whole point of the feature is in the `updateMany` below. Its `where`
 * names the state the job must still be in — no driver, still pending — so
 * Postgres either applies it or does not, once. `count === 0` means somebody
 * else got there first, and that is a normal outcome rather than an error.
 */
export async function claimJob(jobId: string, driverId: string): Promise<ClaimOutcome> {
  const offer = await prisma.jobOffer.findUnique({
    where: { jobId_driverId: { jobId, driverId } },
    select: { id: true, closedAt: true },
  });

  if (!offer) {
    return {
      ok: false,
      reason: 'not offered',
      message: 'That job was not offered to you.',
    };
  }

  const job = await prisma.job.findFirst({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      vehicleId: true,
      // Read before the claim so the audit row says what it actually moved
      // from. A job may be offered while still a draft.
      status: true,
    },
  });
  if (!job) {
    return { ok: false, reason: 'gone', message: 'That job no longer exists.' };
  }

  /*
   * Compliance now, not when the offer went out.
   *
   * An offer can sit unanswered overnight, and a badge that lapses in between
   * would otherwise put a driver on a job they cannot legally take. Checked
   * before the claim rather than after, so a blocked driver never holds the
   * job even briefly.
   */
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { assignedVehicleId: true },
  });
  const verdict = await isDriverCompliantAt(driverId, job.scheduledAt, {
    vehicleId: job.vehicleId ?? driver?.assignedVehicleId,
  });
  if (!verdict.compliant) {
    return {
      ok: false,
      reason: 'blocked',
      message: verdict.reasons[0] ?? 'You cannot be assigned to this job.',
    };
  }

  // The one statement that decides it.
  const claimed = await prisma.job.updateMany({
    where: { id: jobId, driverId: null, status: { in: ['PENDING', 'DRAFT'] } },
    data: { driverId, status: 'ACCEPTED' },
  });

  if (claimed.count === 0) {
    await prisma.jobOffer.update({
      where: { id: offer.id },
      data: { closedAt: new Date(), outcome: 'taken' },
    });
    return {
      ok: false,
      reason: 'taken',
      message: 'Somebody else took that one. Sorry.',
    };
  }

  await prisma.$transaction([
    prisma.jobEvent.create({
      data: { jobId, type: 'ASSIGNED', actorType: 'DRIVER', actorId: driverId },
    }),
    prisma.jobEvent.create({
      data: { jobId, type: 'ACCEPTED', actorType: 'DRIVER', actorId: driverId },
    }),
    prisma.jobOffer.update({
      where: { id: offer.id },
      data: { closedAt: new Date(), outcome: 'accepted' },
    }),
  ]);

  /*
   * Audited, with no acting user.
   *
   * Every other route to a job having a driver goes through the dashboard and
   * is attributed to whoever clicked. This one has nobody in the office in it
   * at all, so without this row the log would show a job that acquired a
   * driver by itself. `userId` stays null because drivers are not users — the
   * `after` snapshot names the driver instead.
   */
  await recordAudit('Job', 'update', jobId, {
    before: { driverId: null, status: job.status },
    after: { driverId, status: 'ACCEPTED', via: 'telegram offer' },
  });

  return { ok: true, message: `Yours — ${job.reference}. The details are on the way.` };
}

/**
 * Tell everybody else it has gone.
 *
 * Edits their message rather than sending another, so the offer stops looking
 * live. A driver holding an Accept button for work somebody else is already
 * driving will press it, and then ring the office about it.
 */
export async function closeOtherOffers(
  jobId: string,
  takenByDriverId: string,
): Promise<{ closed: number }> {
  const others = await prisma.jobOffer.findMany({
    where: { jobId, closedAt: null, driverId: { not: takenByDriverId } },
    select: {
      id: true,
      messageId: true,
      driver: { select: { telegramChatId: true } },
    },
  });

  for (const offer of others) {
    if (offer.driver.telegramChatId && offer.messageId) {
      await sendMessage(
        offer.driver.telegramChatId,
        escapeMarkdown('That job has been taken. Thanks for looking.'),
        // Buttons omitted, so the Accept goes with the edit.
        { editMessageId: offer.messageId },
      );
    }
    await prisma.jobOffer.update({
      where: { id: offer.id },
      data: { closedAt: new Date(), outcome: 'taken' },
    });
  }

  return { closed: others.length };
}

/**
 * How many phones are still holding this offer.
 *
 * What the job screen shows instead of the button, so the office can see a
 * broadcast is out rather than sending a second one on top of it.
 */
export async function liveOfferCount(jobId: string): Promise<number> {
  return prisma.jobOffer.count({ where: { jobId, closedAt: null } });
}

/** Withdraw every live offer — the job was cancelled or assigned by hand. */
export async function withdrawOffers(jobId: string): Promise<{ withdrawn: number }> {
  const live = await prisma.jobOffer.findMany({
    where: { jobId, closedAt: null },
    select: {
      id: true,
      messageId: true,
      driver: { select: { telegramChatId: true } },
    },
  });

  for (const offer of live) {
    if (offer.driver.telegramChatId && offer.messageId) {
      await sendMessage(
        offer.driver.telegramChatId,
        escapeMarkdown('That job is no longer going out. Thanks for looking.'),
        { editMessageId: offer.messageId },
      );
    }
    await prisma.jobOffer.update({
      where: { id: offer.id },
      data: { closedAt: new Date(), outcome: 'withdrawn' },
    });
  }

  return { withdrawn: live.length };
}

/**
 * What the offer says.
 *
 * Deliberately less than a job brief. This is a message to several people,
 * most of whom will not take it, so it carries what somebody needs to decide
 * — when, where, and what it pays — and not the passenger's name or phone
 * number. Those reach one driver, once the job is theirs.
 */
export async function offerText(job: {
  reference: string;
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  driverPricePence: number | null;
}): Promise<string> {
  /*
   * The configured locale, not a hardcoded one. A time rendered in UTC is the
   * wrong time for half the year in London, and this is the line a driver
   * decides on.
   */
  const locale = await getLocaleConfig();

  const lines = [
    `🆕 *${escapeMarkdown(job.reference)}*`,
    `🕒 ${escapeMarkdown(formatDateTime(job.scheduledAt, { locale: locale.locale, timeZone: locale.timeZone }))}`,
    `📍 ${escapeMarkdown(job.pickupText)}`,
    `🏁 ${escapeMarkdown(job.dropoffText)}`,
  ];

  if (job.driverPricePence !== null) {
    lines.push(
      `💷 ${escapeMarkdown(formatMoney(job.driverPricePence, { currency: locale.currency, locale: locale.locale }))}`,
    );
  }

  lines.push('');
  // Said plainly, because it is the part that decides whether they answer now
  // or after the next job. Several phones have this open.
  lines.push(escapeMarkdown('First to accept takes it.'));

  return lines.join('\n');
}
