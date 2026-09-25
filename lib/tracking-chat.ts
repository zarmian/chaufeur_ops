import { driverShown, trackingLinkLive } from './tracking';

/**
 * Whether a passenger may message their driver, and what they may send.
 *
 * **Relayed, never connected.** The passenger types on the tracking page and
 * the bot delivers it to the driver's Telegram; the driver replies in Telegram
 * and it appears on the page. Neither side is given the other's number or
 * handle. That is not a nicety — `lib/tracking.ts` withholds the driver's
 * phone number for the reason that a forwarded link would leave an
 * owner-driver's mobile on the internet, and handing over a Telegram handle
 * instead would be the same disclosure wearing a different hat. It also
 * happens to be the only arrangement that works at all: drivers link to this
 * system by chat id, and most have no public username to link to.
 *
 * Pure, so every rule below is a test rather than a judgement made inside a
 * route handler that nobody reads again.
 */

/** Why the thread is not open. Each is said to the passenger in its own words. */
export type ChatClosedReason =
  /** The link itself has expired, or the journey is over. */
  | 'JOURNEY_OVER'
  /** Before the two-hour mark: there may be no driver yet, and no thread. */
  | 'TOO_EARLY'
  /** Called off. Nothing to arrange with a driver who is not coming. */
  | 'CANCELLED'
  /** Nobody is on the job yet. */
  | 'NO_DRIVER'
  /** A driver who has never linked their Telegram cannot be reached. */
  | 'DRIVER_UNREACHABLE';

export type ChatState =
  | { open: true }
  | { open: false; reason: ChatClosedReason };

export interface ChatJob {
  status: string;
  scheduledAt: Date;
  driverId: string | null;
  /** Whether that driver has linked their Telegram. */
  driverReachable: boolean;
}

/**
 * Whether this journey's thread is open.
 *
 * Deliberately narrower than the page itself. The page answers from the moment
 * the link is issued; the thread opens only when there is a named driver, on
 * their phone, who is about to do this job — because a message that cannot
 * reach anybody is worse than no message box at all. A passenger who types
 * into a dead box believes they have told somebody.
 *
 * Closes the moment the journey does. The thread is about this pickup, and
 * once the passenger is set down there is nothing left to arrange; leaving it
 * open would also leave a channel to a driver's phone sitting in whatever chat
 * the link was forwarded into.
 */
export function chatState(job: ChatJob, now: Date = new Date()): ChatState {
  if (!trackingLinkLive(job, now)) return { open: false, reason: 'JOURNEY_OVER' };
  if (job.status === 'CANCELLED') return { open: false, reason: 'CANCELLED' };

  // Held back with the driver's name, and for the same reasons: before this
  // the crew can still change, and a passenger should not be messaging a
  // driver who may not be the one who turns up.
  if (!driverShown(job.scheduledAt, now)) {
    return { open: false, reason: 'TOO_EARLY' };
  }

  if (!job.driverId) return { open: false, reason: 'NO_DRIVER' };
  if (!job.driverReachable) {
    return { open: false, reason: 'DRIVER_UNREACHABLE' };
  }

  return { open: true };
}

/** What the page says in place of the message box, per reason. */
export const CHAT_CLOSED_TEXT: Record<ChatClosedReason, string> = {
  JOURNEY_OVER: 'This journey is over.',
  TOO_EARLY:
    'You will be able to message your driver from two hours before your pickup.',
  CANCELLED: 'This journey has been cancelled, so there is no driver to message.',
  NO_DRIVER: 'Your driver has not been confirmed yet. Please check back shortly.',
  // Said plainly rather than hidden. A passenger who is told the office can
  // reach the driver will ring the office, which is the right outcome; one
  // shown nothing assumes the feature is broken.
  DRIVER_UNREACHABLE:
    'Your driver cannot be messaged directly. The office can pass anything on.',
};

/**
 * The longest a message may be.
 *
 * Telegram's own limit is 4096 characters, and this has to fit inside a
 * relayed message that also carries a header naming the journey. Short enough
 * to keep a driver's screen usable at the wheel, long enough for the thing
 * people actually send — where they are standing, and what they are wearing.
 */
export const MESSAGE_MAX = 500;

export type MessageCheck =
  | { ok: true; body: string }
  | { ok: false; message: string };

/**
 * Tidy and vet what a passenger typed.
 *
 * Returns the body to store rather than mutating in place, so the caller
 * cannot accidentally persist the raw input. Three failures, each with
 * something the passenger can do about it — a box that rejects a message
 * without saying why is one they will fill in again identically.
 */
export function checkMessage(raw: unknown): MessageCheck {
  if (typeof raw !== 'string') {
    return { ok: false, message: 'Type a message first.' };
  }

  /*
   * Collapse every run of whitespace, including the newlines a phone keyboard
   * inserts. A driver's job card is a Telegram message read at a glance, and a
   * message padded with forty blank lines pushes everything else off screen.
   */
  const body = raw.replace(/\s+/g, ' ').trim();

  if (body === '') return { ok: false, message: 'Type a message first.' };
  if (body.length > MESSAGE_MAX) {
    return {
      ok: false,
      message: `That is too long — ${MESSAGE_MAX} characters at most.`,
    };
  }

  return { ok: true, body };
}
