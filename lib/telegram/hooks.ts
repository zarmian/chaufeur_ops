import { formatDateTime } from '../dates';
import { getLocaleConfig } from '../locale-store';
import {
  notifyCancelled,
  notifyJobChanged,
  notifyWithdrawn,
  refreshJobMessage,
  sendAssignment,
} from './dispatch';

/**
 * Where the job lifecycle meets the bot.
 *
 * Every function here swallows everything. A driver's phone being off, a
 * revoked token, Telegram being down — none of those may fail the operation
 * that triggered the message. Assigning a job must succeed whether or not
 * anybody's phone is on, and an operator who cannot cancel a job because a
 * notification failed will stop using the system.
 *
 * Called *after* the transaction commits, never inside it. A message telling
 * a driver about a change that then rolled back is worse than a late one.
 */

async function quietly(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Deliberately silent. `logUpdate` records what the bot did; a failure
    // to notify is not a failure of the thing being notified about.
  }
}

export async function onJobAssigned(jobId: string): Promise<void> {
  await quietly(() => sendAssignment(jobId));
}

export async function onJobCancelled(jobId: string): Promise<void> {
  await quietly(() => notifyCancelled(jobId));
}

export async function onJobStatusChanged(jobId: string): Promise<void> {
  await quietly(() => refreshJobMessage(jobId));
}

export async function onDriverReplaced(
  jobId: string,
  previousDriverId: string,
): Promise<void> {
  await quietly(() => notifyWithdrawn(jobId, previousDriverId));
}

/**
 * What an edit changed, in the driver's terms — spec 5.3.7.
 *
 * Only the fields a driver acts on. A changed internal note or a corrected
 * client price is not their business and would train them to ignore the
 * message that matters.
 */
export async function onJobEdited(
  jobId: string,
  before: JobSnapshot,
  after: JobSnapshot,
): Promise<void> {
  const locale = await getLocaleConfig().catch(() => null);
  const when = (value: Date) =>
    locale
      ? formatDateTime(value, { locale: locale.locale, timeZone: locale.timeZone })
      : value.toISOString();

  const changes: Array<{ field: string; from: string; to: string }> = [];

  if (before.scheduledAt.getTime() !== after.scheduledAt.getTime()) {
    changes.push({
      field: 'Pickup time',
      from: when(before.scheduledAt),
      to: when(after.scheduledAt),
    });
  }
  if (before.pickupText !== after.pickupText) {
    changes.push({ field: 'Pickup', from: before.pickupText, to: after.pickupText });
  }
  if (before.dropoffText !== after.dropoffText) {
    changes.push({
      field: 'Destination',
      from: before.dropoffText,
      to: after.dropoffText,
    });
  }
  if ((before.flightNumber ?? '') !== (after.flightNumber ?? '')) {
    changes.push({
      field: 'Flight',
      from: before.flightNumber ?? 'none',
      to: after.flightNumber ?? 'none',
    });
  }
  if ((before.passengerName ?? '') !== (after.passengerName ?? '')) {
    changes.push({
      field: 'Passenger',
      from: before.passengerName ?? 'not given',
      to: after.passengerName ?? 'not given',
    });
  }

  if (changes.length === 0) return;
  await quietly(() => notifyJobChanged(jobId, changes));
}

export interface JobSnapshot {
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  flightNumber: string | null;
  passengerName: string | null;
}
