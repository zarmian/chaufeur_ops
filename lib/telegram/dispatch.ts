import { formatDateTime } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { formatMoney } from '../money';
import { absoluteUrl } from '../app-url';
import { canHaveNameBoard, nameBoardPath } from '../name-board';
import { issueNameBoardToken } from '../name-board-store';
import { prisma } from '../prisma';
import { getTelegramConfig } from './config';
import {
  DELAY_CHOICES,
  DRIVER_STEPS,
  encodeCallback,
  escapeMarkdown,
  mapLink,
  nextStep,
  renderBrief,
  renderChanges,
  STEP_LABELS,
  type DriverStep,
} from './protocol';
import { notifyDriver, notifyOps, sendMessage, type InlineButton } from './send';

/**
 * Getting a job to a driver's phone, and keeping it current — spec 5.3, 5.4.
 *
 * One message per job, edited as things happen, rather than a new message per
 * event. A driver working six jobs a day would otherwise have thirty messages
 * to scroll through to find the one they are actually driving.
 *
 * Which means the message id has to be remembered. It lives on the job's
 * `ASSIGNED` event metadata rather than in a column: it belongs to that
 * assignment, and a reassignment should not inherit the previous driver's
 * message.
 */

/** How the job reads on a phone. Assembled here; formatted in `protocol`. */
async function briefFor(jobId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      pickupText: true,
      pickupPostcode: true,
      pickupLat: true,
      pickupLng: true,
      dropoffText: true,
      passengerName: true,
      passengerPhone: true,
      flightNumber: true,
      jobType: true,
      nameBoardToken: true,
      notes: true,
      driverPricePence: true,
      status: true,
      driverId: true,
      client: { select: { name: true } },
      vehicle: { select: { registration: true, make: true, model: true } },
      events: { select: { type: true }, orderBy: { occurredAt: 'asc' } },
    },
  });
  if (!job) return null;

  const locale = await getLocaleConfig();

  return {
    job,
    text: renderBrief({
      reference: job.reference,
      when: formatDateTime(job.scheduledAt, {
        locale: locale.locale,
        timeZone: locale.timeZone,
      }),
      pickup: job.pickupText,
      dropoff: job.dropoffText,
      // The passenger, not the client: the name that matters at the kerb.
      passenger: job.passengerName ?? job.client?.name ?? null,
      /*
       * The passenger's number, when the job carries one.
       *
       * Plain text rather than a button: Telegram makes a phone number in
       * message text tappable by itself, and an inline keyboard cannot hold a
       * `tel:` URL — it rejects the whole keyboard, so the card would fail to
       * send rather than arrive one button short.
       *
       * The alternative is the driver ringing the office to be given a number
       * the office reads off the same screen this message came from.
       */
      passengerPhone: job.passengerPhone,
      vehicle: job.vehicle
        ? `${job.vehicle.registration} — ${job.vehicle.make} ${job.vehicle.model}`
        : null,
      flightNumber: job.flightNumber,
      notes: job.notes,
      /*
       * The board, when there is one to link to.
       *
       * Read rather than issued: a driver's job card must not be the thing
       * that mints a token, because `refreshJobMessage` runs on every status
       * tap and a card that reissued the link each time would leave the
       * driver holding a board that had just stopped working. The office
       * issues it by opening the job, which is where the link is wanted
       * anyway.
       */
      nameBoardUrl:
        job.nameBoardToken && canHaveNameBoard(job)
          ? absoluteUrl(nameBoardPath(job.nameBoardToken))
          : null,
      driverPay:
        job.driverPricePence === null
          ? null
          : formatMoney(job.driverPricePence, {
              currency: locale.currency,
              locale: locale.locale,
            }),
      recorded: job.events.map((event) => event.type),
    }),
  };
}

/**
 * The buttons under the brief.
 *
 * Acceptance first where it is required, then the status keyboard. Only ever
 * one status button: offering all four invites a driver to tap Completed at
 * the start of the shift, and the sequence is what makes the wait-time
 * arithmetic mean anything.
 */
export function keyboardFor(
  jobId: string,
  recorded: readonly string[],
  options: {
    awaitingAcceptance: boolean;
    statusOpen: boolean;
    /** Opens the pickup in the driver's maps app, when the job has a where. */
    navigateUrl?: string | null;
  },
): InlineButton[][] {
  if (options.awaitingAcceptance) {
    return [
      [
        { text: '✅ Accept', callbackData: encodeCallback({ kind: 'accept', jobId }) },
        { text: '❌ Decline', callbackData: encodeCallback({ kind: 'decline', jobId }) },
      ],
    ];
  }

  if (!options.statusOpen) return [];

  const rows: InlineButton[][] = [];
  const step = nextStep(recorded);

  if (step) {
    rows.push([
      {
        text: STEP_LABELS[step],
        callbackData: encodeCallback({ kind: 'step', jobId, step }),
      },
    ]);
  }

  /*
   * Navigate and Running late, on their own row under the status button.
   *
   * Not beside it: the status button is the one that must never be hit by
   * accident, because the sequence is what makes the wait-time arithmetic
   * mean anything, and a thumb reaching for "Navigate" on a phone in a
   * cradle should not be able to land on "Passenger on board".
   *
   * Running late is offered only while the job is still running. Once the
   * passenger is aboard, lateness is a fact about a journey in progress and
   * there is nobody left waiting to be told.
   */
  const secondary: InlineButton[] = [];
  if (options.navigateUrl) {
    secondary.push({ text: '🧭 Navigate', url: options.navigateUrl });
  }
  if (step && !recorded.includes('POB')) {
    secondary.push({
      text: '⏱ Running late',
      callbackData: encodeCallback({ kind: 'late', jobId }),
    });
  }
  if (secondary.length > 0) rows.push(secondary);

  return rows;
}

/** Where the pickup is, for the maps button. */
function navigateUrlFor(job: {
  pickupLat: number | null;
  pickupLng: number | null;
  pickupPostcode: string | null;
  pickupText: string;
}): string | null {
  return mapLink({
    lat: job.pickupLat,
    lng: job.pickupLng,
    postcode: job.pickupPostcode,
    text: job.pickupText,
  });
}

/** The delay choices, as a keyboard. */
export function delayKeyboard(jobId: string): InlineButton[][] {
  const buttons = DELAY_CHOICES.map((minutes) => ({
    text: `${minutes} min`,
    callbackData: encodeCallback({ kind: 'late-eta', jobId, minutes }),
  }));

  // Three to a row: six in a line is unreadable on a phone, and one per row
  // is a scroll.
  return [buttons.slice(0, 3), buttons.slice(3)];
}

/**
 * Whether the status keyboard should be showing — spec 5.4.1.
 *
 * From two hours before pickup. Earlier and a driver taps On My Way the night
 * before; later and an early arrival has nothing to press.
 */
export function statusKeyboardOpen(
  scheduledAt: Date,
  now: Date = new Date(),
  hoursBefore = 2,
): boolean {
  return now.getTime() >= scheduledAt.getTime() - hoursBefore * 60 * 60 * 1000;
}

/**
 * Send the brief when a job is assigned — spec 5.3.1.
 *
 * Returns quietly when the bot is off or the driver is not linked. An
 * assignment must succeed either way: plenty of drivers will never link, and
 * the dispatch view is where that shows.
 */
export async function sendAssignment(jobId: string): Promise<void> {
  const config = await getTelegramConfig();
  if (!config.enabled || !config.notifyOnAssignment) return;

  /*
   * The board's link is minted here, once, when the job first goes out.
   *
   * Here rather than in `briefFor`, which also builds the card for every
   * subsequent refresh: the driver is the person who needs the board, and
   * waiting for somebody in the office to open the job first would mean the
   * card that reaches them has no link on it. A no-op on anything that is not
   * an airport transfer with a passenger named on it, and idempotent after
   * the first time, so the link a driver saved this morning still works.
   */
  await issueNameBoardToken(jobId);

  const built = await briefFor(jobId);
  const driverId = built?.job.driverId;
  if (!built || !driverId) return;

  const { job, text } = built;
  const recorded = job.events.map((event) => event.type);

  const result = await notifyDriver(driverId, text, {
    buttons: keyboardFor(jobId, recorded, {
      awaitingAcceptance: config.requireAcceptance && !recorded.includes('ACCEPTED'),
      statusOpen: statusKeyboardOpen(job.scheduledAt),
      navigateUrl: navigateUrlFor(job),
    }),
  });

  if (result.ok && result.messageId) {
    await rememberMessage(jobId, driverId, result.messageId);
  }
}

/**
 * Redraw the message in place — spec 5.4.5.
 *
 * Best-effort throughout. Telegram refuses an edit whose text is unchanged,
 * and refuses one on a message older than 48 hours; neither is worth
 * surfacing, and neither should fail the tap that triggered it.
 */
export async function refreshJobMessage(jobId: string): Promise<void> {
  const built = await briefFor(jobId);
  const driverId = built?.job.driverId;
  if (!built || !driverId) return;

  const { job, text } = built;
  const sent = await rememberedMessage(jobId, driverId);
  if (!sent) return;

  const recorded = job.events.map((event) => event.type);
  const finished = ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(job.status);

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { telegramChatId: true },
  });
  if (!driver?.telegramChatId) return;

  await sendMessage(driver.telegramChatId, text, {
    editMessageId: sent,
    buttons: finished
      ? []
      : keyboardFor(jobId, recorded, {
          awaitingAcceptance: false,
          statusOpen: statusKeyboardOpen(job.scheduledAt),
          navigateUrl: navigateUrlFor(job),
        }),
  });
}

/**
 * Tell the driver what changed — spec 5.3.7.
 *
 * A separate message rather than only an edit, because an edit to a message
 * further up the chat produces no notification: a pickup time that moved an
 * hour would go unread.
 */
export async function notifyJobChanged(
  jobId: string,
  changes: Array<{ field: string; from: string; to: string }>,
): Promise<void> {
  if (changes.length === 0) return;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { reference: true, driverId: true, status: true },
  });
  const driverId = job?.driverId;
  if (!job || !driverId) return;
  // Only somebody who has agreed to do it needs telling it moved.
  if (!['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'].includes(job.status)) return;

  await notifyDriver(driverId, renderChanges(job.reference, changes));
  await refreshJobMessage(jobId);
}

/** Spec 5.3.6 — the driver who is no longer doing it needs to know. */
export async function notifyWithdrawn(
  jobId: string,
  previousDriverId: string,
): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { reference: true },
  });
  if (!job) return;

  await notifyDriver(
    previousDriverId,
    `*${escapeMarkdown(job.reference)}* has been given to another driver\\. Nothing for you to do\\.`,
  );
}

/** Spec 5.3.8 — immediately, because they may already be driving to it. */
export async function notifyCancelled(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { reference: true, driverId: true },
  });
  const driverId = job?.driverId;
  if (!job || !driverId) return;

  await notifyDriver(
    driverId,
    `🚫 *${escapeMarkdown(job.reference)} is cancelled*\\. Do not travel\\.`,
  );
  await refreshJobMessage(jobId);
}

/**
 * Where the driver's copy of the job lives.
 *
 * On the `ASSIGNED` event's metadata rather than in a column: the message
 * belongs to that assignment, and reassigning should not leave the new driver
 * editing the old driver's message.
 */
async function rememberMessage(
  jobId: string,
  driverId: string,
  messageId: number,
): Promise<void> {
  const event = await prisma.jobEvent.findFirst({
    where: { jobId, type: 'ASSIGNED' },
    orderBy: { occurredAt: 'desc' },
  });
  if (!event) return;

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  await prisma.jobEvent.update({
    where: { id: event.id },
    data: { metadata: { ...metadata, telegramMessageId: messageId, driverId } },
  });
}

async function rememberedMessage(
  jobId: string,
  driverId: string,
): Promise<number | null> {
  const event = await prisma.jobEvent.findFirst({
    where: { jobId, type: 'ASSIGNED' },
    orderBy: { occurredAt: 'desc' },
  });
  if (!event) return null;

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  if (metadata.driverId !== driverId) return null;

  const id = metadata.telegramMessageId;
  return typeof id === 'number' ? id : null;
}

/** Ops alerting, wrapped so callers do not each repeat the escaping. */
export async function alertOps(text: string): Promise<void> {
  await notifyOps(escapeMarkdown(text));
}

export { DRIVER_STEPS, type DriverStep };
