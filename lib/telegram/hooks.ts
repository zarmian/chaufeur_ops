import { getBranding } from '../branding-store';
import {
  bookingConfirmation,
  driverAssigned,
  driverEnRoute,
  messageClient,
} from '../client-messaging';
import { formatDateTime } from '../dates';
import { etaForJob } from '../eta/store';
import { getLocaleConfig } from '../locale-store';
import { prisma } from '../prisma';
import {
  notifyCancelled,
  notifyJobChanged,
  notifyWithdrawn,
  refreshJobMessage,
  sendAssignment,
} from './dispatch';
import { withdrawOffers } from './offers';

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
  /*
   * Any offer still out is dead the moment somebody is assigned by hand.
   *
   * The office broadcasting a job and then giving it to a named driver a
   * minute later is not an edge case — it is what happens when the phone
   * rings before anybody taps. Leaving the offers live means a driver accepts
   * work that is already somebody else's and is told so, which reads as the
   * system having taken it back off them.
   *
   * A no-op when the job was never offered, so it is safe on every
   * assignment. Withdrawn first, so the broadcast is closed before the
   * assigned driver's brief goes out.
   */
  await quietly(async () => {
    await withdrawOffers(jobId);
  });
  await quietly(() => sendAssignment(jobId));
  await quietly(() => tellClient(jobId, 'driver_assigned'));
}

/** Spec 5.10.3 — the client is told a car is booked, if they want to be. */
export async function onJobBooked(jobId: string): Promise<void> {
  await quietly(() => tellClient(jobId, 'booking_confirmation'));
}

/** Spec 5.10.3 — sent when the driver taps On my way. */
export async function onDriverEnRoute(jobId: string): Promise<void> {
  await quietly(() => tellClient(jobId, 'driver_en_route'));
}

/**
 * Build and send whichever client template applies.
 *
 * Gated three times over before anything leaves — the template must be on,
 * the client must want it, and the channel must be configured — so this is
 * safe to call from any lifecycle point without checking first.
 */
async function tellClient(
  jobId: string,
  template: 'booking_confirmation' | 'driver_assigned' | 'driver_en_route',
): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      reference: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      clientId: true,
      driver: { select: { name: true, phone: true } },
      vehicle: { select: { make: true, model: true } },
    },
  });
  if (!job?.clientId) return;

  const branding = await getBranding();
  const forMessage = {
    reference: job.reference,
    scheduledAt: job.scheduledAt,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    driverName: job.driver?.name ?? null,
    driverPhone: job.driver?.phone ?? null,
    vehicle: job.vehicle ? `${job.vehicle.make} ${job.vehicle.model}` : null,
  };

  // Only the en-route message carries a time, because it is the only one
  // sent while the driver is moving. Failing to compute one must not stop
  // the message: `etaForJob` returns null rather than guessing, and the
  // template drops the clause.
  const etaPhrase =
    template === 'driver_en_route'
      ? await etaForJob(jobId)
          .then((eta) => eta?.phrase ?? null)
          .catch(() => null)
      : null;

  const content =
    template === 'booking_confirmation'
      ? await bookingConfirmation(forMessage, branding.tradingName)
      : template === 'driver_assigned'
        ? await driverAssigned(forMessage, branding.tradingName)
        : await driverEnRoute(forMessage, branding.tradingName, etaPhrase);

  await messageClient(job.clientId, template, content);
}

export async function onJobCancelled(jobId: string): Promise<void> {
  // Same reasoning as an assignment, more urgently: an Accept button on a
  // cancelled job is an invitation to drive to a pickup nobody is waiting at.
  await quietly(async () => {
    await withdrawOffers(jobId);
  });
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
