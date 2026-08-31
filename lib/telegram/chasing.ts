import { conflictsForDay } from '../conflict-store';
import {
  daysBetweenDates,
  endOfZonedDay,
  formatDate,
  formatDateTime,
  startOfZonedDay,
} from '../dates';
import { UNPRICED_WHERE } from '../jobs';
import { getLocaleConfig } from '../locale-store';
import { formatMoney } from '../money';
import { prisma } from '../prisma';
import { getTelegramConfig } from './config';
import { alertOps } from './dispatch';
import { escapeMarkdown } from './protocol';
import { notifyDriver } from './send';

/**
 * The scheduled nudges — spec 5.8, 5.9.3 and 5.7.5.
 *
 * All of it is best-effort and none of it blocks anything. What matters is
 * the restraint: a bot that messages a driver every day about a licence
 * expiring in eleven months is a bot whose messages get muted, and then the
 * one that matters is muted too.
 *
 * So the ladder is 30, 14 and 7 days — and only on those days, not every day
 * inside the window. Once something has actually expired the daily message
 * starts, because at that point the driver cannot legally work and a nuisance
 * is the point.
 */

/** Days out at which a driver is told. Exactly these, not the range. */
const CHASE_AT_DAYS = [30, 14, 7] as const;

export interface ChaseSummary {
  messaged: number;
  expired: number;
  skipped: number;
}

/**
 * Document expiry — spec 5.8.1 and 5.8.2.
 *
 * The message names the document and the date and asks for a photo, because
 * "your licence expires soon" prompts nothing a driver can act on from a
 * phone.
 */
export async function chaseExpiringDocuments(
  now: Date = new Date(),
): Promise<ChaseSummary> {
  const config = await getTelegramConfig();
  if (!config.enabled || !config.chaseDocuments) {
    return { messaged: 0, expired: 0, skipped: 0 };
  }

  const locale = await getLocaleConfig();
  const summary: ChaseSummary = { messaged: 0, expired: 0, skipped: 0 };

  const drivers = await prisma.driver.findMany({
    where: { status: 'ACTIVE', telegramChatId: { not: null } },
    select: {
      id: true,
      name: true,
      dvlaLicenceExpiry: true,
      phvBadgeExpiry: true,
      assignedVehicle: {
        select: { registration: true, motExpiry: true, insuranceExpiry: true },
      },
    },
  });

  for (const driver of drivers) {
    const due: Array<{ what: string; on: Date }> = [];

    if (driver.dvlaLicenceExpiry) {
      due.push({ what: 'DVLA licence', on: driver.dvlaLicenceExpiry });
    }
    if (driver.phvBadgeExpiry) {
      due.push({ what: 'PHV badge', on: driver.phvBadgeExpiry });
    }
    // The car they drive is their problem too: an assignment is blocked by a
    // lapsed MOT just as surely as by a lapsed badge.
    if (driver.assignedVehicle?.motExpiry) {
      due.push({
        what: `MOT on ${driver.assignedVehicle.registration}`,
        on: driver.assignedVehicle.motExpiry,
      });
    }
    if (driver.assignedVehicle?.insuranceExpiry) {
      due.push({
        what: `insurance on ${driver.assignedVehicle.registration}`,
        on: driver.assignedVehicle.insuranceExpiry,
      });
    }

    for (const item of due) {
      const days = daysBetweenDates(now, item.on);
      const expired = days < 0;

      if (!expired && !CHASE_AT_DAYS.includes(days as (typeof CHASE_AT_DAYS)[number])) {
        summary.skipped += 1;
        continue;
      }

      const on = formatDate(item.on, {
        locale: locale.locale,
        timeZone: locale.timeZone,
      });

      const text = expired
        ? `⚠️ Your ${item.what} expired on ${on}. You cannot be given work until it is renewed. Send a photo of the new one here.`
        : `Your ${item.what} expires on ${on} — ${days} day${days === 1 ? '' : 's'} away. Send a photo of the renewal here when you have it.`;

      const sent = await notifyDriver(driver.id, escapeMarkdown(text));
      if (sent.ok) {
        summary.messaged += 1;
        if (expired) summary.expired += 1;
      }
    }
  }

  return summary;
}

/**
 * Jobs with nobody on them — spec 5.9.3.
 *
 * One alert per job per run, aimed at the window where it is still fixable.
 * Alerting on a job three weeks out would be noise; alerting an hour before
 * is too late to do anything but apologise.
 */
export async function alertUnassignedJobs(
  now: Date = new Date(),
): Promise<{ alerted: number }> {
  const config = await getTelegramConfig();
  if (!config.enabled || !config.alertUnassigned) return { alerted: 0 };

  const horizon = new Date(now.getTime() + config.unassignedAlertHours * 60 * 60 * 1000);
  const locale = await getLocaleConfig();

  const jobs = await prisma.job.findMany({
    where: {
      driverId: null,
      status: { in: ['PENDING', 'DRAFT'] },
      scheduledAt: { gte: now, lte: horizon },
    },
    orderBy: { scheduledAt: 'asc' },
    select: { reference: true, scheduledAt: true, pickupText: true },
    take: 25,
  });

  if (jobs.length === 0) return { alerted: 0 };

  const lines = jobs.map(
    (job) =>
      `${formatDateTime(job.scheduledAt, { locale: locale.locale, timeZone: locale.timeZone })} — ${job.reference} — ${job.pickupText}`,
  );

  await alertOps(
    `${jobs.length} job${jobs.length === 1 ? '' : 's'} in the next ${config.unassignedAlertHours}h with no driver:\n${lines.join('\n')}`,
  );

  return { alerted: jobs.length };
}

/**
 * Assignments nobody has answered — spec 5.3.5.
 *
 * Alerts, and deliberately does not reassign. Picking the next driver is a
 * judgement about who is where and who is awake, and a system that guesses
 * will guess wrong at five in the morning.
 */
export async function alertUnansweredAssignments(
  now: Date = new Date(),
): Promise<{ alerted: number }> {
  const config = await getTelegramConfig();
  if (!config.enabled || !config.requireAcceptance) return { alerted: 0 };

  const cutoff = new Date(now.getTime() - config.acceptanceWindowMinutes * 60 * 1000);

  const jobs = await prisma.job.findMany({
    where: {
      status: 'ASSIGNED',
      driverId: { not: null },
      scheduledAt: { gte: now },
      events: {
        some: { type: 'ASSIGNED', occurredAt: { lte: cutoff } },
        none: { type: { in: ['ACCEPTED', 'DECLINED'] } },
      },
    },
    select: {
      reference: true,
      scheduledAt: true,
      driver: { select: { name: true } },
    },
    take: 25,
  });

  if (jobs.length === 0) return { alerted: 0 };

  await alertOps(
    `Not answered within ${config.acceptanceWindowMinutes} min:\n${jobs
      .map((job) => `${job.reference} — ${job.driver?.name ?? 'unknown driver'}`)
      .join('\n')}`,
  );

  return { alerted: jobs.length };
}

/**
 * Tomorrow's clashes — spec 6.2.7.
 *
 * Tomorrow rather than today, because a clash you find out about on the
 * morning it happens is a clash you apologise for rather than fix.
 *
 * Genuine overlaps only. A tight-but-workable gap in a daily digest is the
 * kind of noise that makes the digest itself get filtered.
 */
export async function digestTomorrowsConflicts(
  now: Date = new Date(),
): Promise<{ alerted: number }> {
  const config = await getTelegramConfig();
  if (!config.enabled) return { alerted: 0 };

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const entries = (await conflictsForDay(tomorrow)).filter(
    (entry) => entry.overlapping,
  );

  if (entries.length === 0) return { alerted: 0 };

  const lines = entries
    .slice(0, 20)
    .map(
      (entry) =>
        `${entry.who}: ${entry.reference} and ${entry.otherReference} overlap`,
    );

  await alertOps(
    `${entries.length} clash${entries.length === 1 ? '' : 'es'} tomorrow:\n${lines.join('\n')}`,
  );

  return { alerted: entries.length };
}

/**
 * Drop position pings past the retention window — spec 5.7.5.
 *
 * A documented privacy position rather than an oversight. Knowing where
 * somebody was three months ago serves no operational purpose, and keeping it
 * only creates obligations.
 */
export async function purgeOldPositions(
  now: Date = new Date(),
): Promise<{ purged: number }> {
  const config = await getTelegramConfig();
  const cutoff = new Date(
    now.getTime() - config.locationRetentionDays * 24 * 60 * 60 * 1000,
  );

  const { count } = await prisma.driverPosition.deleteMany({
    where: { recordedAt: { lt: cutoff } },
  });

  return { purged: count };
}

/**
 * Conversations nobody finished.
 *
 * Expired rows are already ignored on read; this stops the table growing
 * without bound on an install where a lot of receipts get abandoned.
 */
export async function purgeStaleConversations(
  now: Date = new Date(),
): Promise<{ purged: number }> {
  const { count } = await prisma.telegramConversation.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
  return { purged: count };
}

/**
 * Invoices past their due date — spec 5.9.3, the one alert in that list that
 * was never built.
 *
 * Money that has been earned and not collected is the thing an operator can
 * do something about today, and it is also the thing nobody looks at until
 * somebody asks. The invoices screen shows it; the point of this is that
 * nobody has to remember to open the invoices screen.
 *
 * Only what has genuinely gone past due and is genuinely still owed. A credit
 * note reverses an invoice without money arriving, so `CREDITED` is not a
 * debt; `PART_PAID` is, for the remainder.
 */
export interface OverdueInvoice {
  number: string;
  dueDate: Date;
  owedPence: number;
  daysLate: number;
  /** The booker who gets chased, not the passenger who rode. */
  who: string;
}

/**
 * What is genuinely late and genuinely still owed.
 *
 * Separate from the alerting so it can be asked without a bot, and tested
 * without one — the selection is where this goes wrong in a way nobody
 * notices, because an overdue list that quietly includes a credit note is a
 * list somebody chases a client over.
 *
 * `CREDITED` is not a debt: a credit note reverses an invoice without money
 * arriving. `PART_PAID` is, for the remainder.
 */
export async function overdueInvoices(
  now: Date,
  timeZone: string,
  take = 20,
): Promise<OverdueInvoice[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      // `dueDate` is a date column, so "overdue" means the day has passed —
      // an invoice due today is not late until tomorrow.
      dueDate: { lt: startOfZonedDay(now, timeZone) },
      status: { in: ['SENT', 'PART_PAID', 'OVERDUE'] },
    },
    orderBy: { dueDate: 'asc' },
    select: {
      number: true,
      dueDate: true,
      grossPence: true,
      paidPence: true,
      client: { select: { name: true } },
      account: { select: { name: true } },
    },
    take,
  });

  return invoices
    .map((invoice) => ({
      number: invoice.number,
      dueDate: invoice.dueDate,
      owedPence: invoice.grossPence - invoice.paidPence,
      daysLate: daysBetweenDates(invoice.dueDate, now),
      who: invoice.account?.name ?? invoice.client?.name ?? 'no recipient recorded',
    }))
    // An invoice marked SENT but already settled in full is not a debt,
    // whatever its status column says.
    .filter((invoice) => invoice.owedPence > 0);
}

/**
 * Invoices past their due date — spec 5.9.3, the one alert in that list that
 * was never built.
 *
 * Money earned and not collected is the thing an operator can act on today,
 * and also the thing nobody looks at until somebody asks. The invoices screen
 * shows it; the point of this is that nobody has to remember to open it.
 */
export async function alertOverdueInvoices(
  now: Date = new Date(),
): Promise<{ alerted: number; totalPence: number }> {
  const config = await getTelegramConfig();
  if (!config.enabled) return { alerted: 0, totalPence: 0 };

  const locale = await getLocaleConfig();
  const outstanding = await overdueInvoices(now, locale.timeZone);
  if (outstanding.length === 0) return { alerted: 0, totalPence: 0 };

  const totalPence = outstanding.reduce((sum, invoice) => sum + invoice.owedPence, 0);
  const money = (pence: number) =>
    formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  const lines = outstanding.map(
    (invoice) =>
      `${invoice.number} — ${invoice.who} — ${money(invoice.owedPence)}, ${invoice.daysLate} day${invoice.daysLate === 1 ? '' : 's'} late`,
  );

  await alertOps(
    `${outstanding.length} overdue invoice${outstanding.length === 1 ? '' : 's'}, ${money(totalPence)} outstanding:\n${lines.join('\n')}`,
  );

  return { alerted: outstanding.length, totalPence };
}

/**
 * One message at the start of the day — the state of it, in a phone.
 *
 * Everything in here is already answerable: `/today` lists the jobs,
 * `/unassigned` the gaps, `/unpriced` the money not yet asked for. The
 * difference is that this arrives without anyone asking, at the hour when
 * acting on it is still cheap. A job with no driver at six in the morning is
 * a phone call; the same job at nine is a client ringing to ask where the car
 * is.
 *
 * Deliberately counts rather than lists, except for the gaps. A digest long
 * enough to scroll is a digest nobody reads to the end of, and the end is
 * where the unassigned jobs would be.
 */
export interface DigestFacts {
  total: number;
  withoutDriver: Array<{ reference: string; scheduledAt: Date; pickupText: string }>;
  unpriced: number;
}

/** The state of today, as numbers. Asked without a bot, and tested without one. */
export async function digestFacts(now: Date, timeZone: string): Promise<DigestFacts> {
  const from = startOfZonedDay(now, timeZone);
  const to = endOfZonedDay(now, timeZone);

  const [jobs, unpriced] = await Promise.all([
    prisma.job.findMany({
      where: { scheduledAt: { gte: from, lt: to }, status: { notIn: ['CANCELLED'] } },
      orderBy: { scheduledAt: 'asc' },
      select: {
        reference: true,
        scheduledAt: true,
        pickupText: true,
        driverId: true,
      },
    }),
    prisma.job.count({
      where: {
        ...UNPRICED_WHERE,
        scheduledAt: { gte: from, lt: to },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
    }),
  ]);

  return {
    total: jobs.length,
    withoutDriver: jobs
      .filter((job) => job.driverId === null)
      .map(({ reference, scheduledAt, pickupText }) => ({
        reference,
        scheduledAt,
        pickupText,
      })),
    unpriced,
  };
}

export async function morningDigest(
  now: Date = new Date(),
): Promise<{ sent: boolean; jobs: number; unassigned: number }> {
  const config = await getTelegramConfig();
  if (!config.enabled) return { sent: false, jobs: 0, unassigned: 0 };

  const locale = await getLocaleConfig();
  const facts = await digestFacts(now, locale.timeZone);

  if (facts.total === 0) {
    await alertOps(`Nothing booked for ${formatDate(now, locale)}.`);
    return { sent: true, jobs: 0, unassigned: 0 };
  }

  // Plain text: `alertOps` escapes what it is given, so markdown added here
  // would reach the chat as literal asterisks and backslashes.
  const lines = [
    `${formatDate(now, locale)} — ${facts.total} job${facts.total === 1 ? '' : 's'}`,
  ];

  if (facts.withoutDriver.length > 0) {
    lines.push('', `⚠️ ${facts.withoutDriver.length} with no driver:`);
    for (const job of facts.withoutDriver.slice(0, 10)) {
      lines.push(
        `${formatDateTime(job.scheduledAt, {
          locale: locale.locale,
          timeZone: locale.timeZone,
        }).slice(-5)} ${job.reference} — ${job.pickupText}`,
      );
    }
    if (facts.withoutDriver.length > 10) {
      lines.push(`…and ${facts.withoutDriver.length - 10} more`);
    }
  } else {
    lines.push('', '✅ Every job has a driver.');
  }

  if (facts.unpriced > 0) {
    // The number this whole rebuild exists to keep at zero.
    lines.push('', `⚠️ ${facts.unpriced} with no price.`);
  }

  await alertOps(lines.join('\n'));

  return { sent: true, jobs: facts.total, unassigned: facts.withoutDriver.length };
}
