import { formatDateTime } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { prisma } from '../prisma';
import { alertOps } from './dispatch';

/**
 * A driver saying they will be late, and by how long — and the office
 * hearing it from them rather than from the client.
 *
 * Today a delay arrives as free text: "stuck on the M4", relayed to ops as a
 * line of chat. That is better than nothing and worse than it looks. It
 * carries no number, so nobody can act on it beyond ringing the driver; it
 * scrolls away, so three weeks later when a client disputes a late arrival
 * there is no record of when anybody knew; and it needs typing, which a
 * driver in traffic does at the next red light or not at all.
 *
 * So: two taps, a number, and a `DELAYED` event on the job. The same reason
 * wait time is computed from `ARRIVED` and `POB` rather than typed — if it
 * matters commercially, it belongs on the job and not in a chat.
 */

export interface DelayOutcome {
  /** Shown to the driver in the callback toast. */
  message: string;
  outcome: string;
  recorded: boolean;
}

/**
 * Record a reported delay and tell the office.
 *
 * The driver is told the office knows, because the whole reason they pressed
 * the button is that they are worried nobody does.
 */
export async function reportDelay(
  jobId: string,
  driverId: string,
  minutes: number,
): Promise<DelayOutcome> {
  const job = await prisma.job.findFirst({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      driverId: true,
      status: true,
      scheduledAt: true,
      pickupText: true,
    },
  });

  if (!job) {
    return { message: 'That job no longer exists.', outcome: 'no such job', recorded: false };
  }

  /*
   * Only the driver the job is on.
   *
   * A button survives a reassignment — the previous driver still has the
   * message in their chat — and a delay recorded against a job somebody else
   * is now driving would send the office chasing the wrong car.
   */
  if (job.driverId !== driverId) {
    return {
      message: 'This job is not yours any more.',
      outcome: 'not this driver',
      recorded: false,
    };
  }

  if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(job.status)) {
    return {
      message: 'That job is already closed.',
      outcome: 'job closed',
      recorded: false,
    };
  }

  const locale = await getLocaleConfig();
  const expected = new Date(job.scheduledAt.getTime() + minutes * 60 * 1000);

  await prisma.jobEvent.create({
    data: {
      jobId: job.id,
      type: 'DELAYED',
      actorType: 'DRIVER',
      actorId: driverId,
      occurredAt: new Date(),
      // The number the driver actually chose, so the record answers "how late
      // did they say?" rather than only "they said something".
      metadata: { minutes, expectedAt: expected.toISOString() },
    },
  });

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { name: true },
  });

  await alertOps(
    `${driver?.name ?? 'A driver'} is running ~${minutes} min late for ${job.reference} — ` +
      `${job.pickupText}, now about ${formatDateTime(expected, {
        locale: locale.locale,
        timeZone: locale.timeZone,
      })}.`,
  );

  return {
    message: `Thanks — the office knows you are about ${minutes} minutes behind.`,
    outcome: `delay ${minutes}m recorded`,
    recorded: true,
  };
}
