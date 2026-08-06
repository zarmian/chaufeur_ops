import { daysBetweenDates, formatDate, formatDateTime } from '../dates';
import { getLocaleConfig } from '../locale-store';
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
