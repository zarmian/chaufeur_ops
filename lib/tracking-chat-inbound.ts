/**
 * Deciding which journey an incoming text belongs to.
 *
 * A reply on Telegram carries the job in the button the driver pressed. A text
 * message carries nothing but a phone number and some words, so the thread it
 * belongs to has to be inferred — and inferring wrong means putting one
 * passenger's answer on another passenger's page.
 *
 * Pure, because every branch below is somebody reading something that was not
 * meant for them, or a driver's words going nowhere.
 */

export interface InboundCandidate {
  jobId: string;
  reference: string;
  /** When the passenger last said something, or null if they never have. */
  lastAskedAt: Date | null;
}

export type InboundRoute =
  | { to: 'thread'; jobId: string }
  /**
   * Nothing to attach it to. The text still has to go somewhere — a driver who
   * types "stuck on the M4" has told somebody something useful — so it goes to
   * the office, which is what the Telegram handler already does with a message
   * that is not a reply to anything.
   */
  | { to: 'ops'; reason: InboundUnroutable };

export type InboundUnroutable =
  /** The number is not a driver's, or not one we can read. */
  | 'UNKNOWN_SENDER'
  /** A driver with no live journey carrying an open thread. */
  | 'NO_OPEN_THREAD'
  /** Several, and nothing to tell them apart. */
  | 'AMBIGUOUS';

/**
 * Which open thread this text is a reply to.
 *
 * **Only a journey whose thread is already open.** The candidates handed in
 * have been filtered to those, deliberately: a text that arrives hours after
 * a journey ended must not reopen it, and a driver texting the office about
 * next week must not land on a stranger's tracking page. Outside an open
 * thread the text is the office's, not a passenger's.
 *
 * **The passenger has to have spoken first.** A thread nobody has written to
 * is not a conversation, and a driver's unprompted text is not a reply to it.
 * This is what stops a driver's "running 10 late" appearing to a passenger who
 * never asked anything — they get the proper status message instead, which is
 * what the delay flow is for.
 *
 * **Where two threads are open, the most recently asked wins.** A driver with
 * two live journeys who has been asked something by both is answering the one
 * that just buzzed. It is a guess, and it is the only honest one available —
 * so where the two were asked within a few minutes of each other it refuses
 * to guess at all and gives the text to the office, who can see both jobs and
 * ask.
 */
export const TOO_CLOSE_TO_CALL_MS = 5 * 60_000;

export function routeInbound(
  candidates: InboundCandidate[],
  sender: { known: boolean },
): InboundRoute {
  if (!sender.known) return { to: 'ops', reason: 'UNKNOWN_SENDER' };

  // A thread the passenger has never written to is not one to reply into.
  const asked = candidates
    .filter((candidate): candidate is InboundCandidate & { lastAskedAt: Date } =>
      candidate.lastAskedAt !== null,
    )
    .sort((a, b) => b.lastAskedAt.getTime() - a.lastAskedAt.getTime());

  if (asked.length === 0) return { to: 'ops', reason: 'NO_OPEN_THREAD' };

  const [newest, next] = asked;
  if (
    next &&
    newest!.lastAskedAt.getTime() - next.lastAskedAt.getTime() <
      TOO_CLOSE_TO_CALL_MS
  ) {
    return { to: 'ops', reason: 'AMBIGUOUS' };
  }

  return { to: 'thread', jobId: newest!.jobId };
}

/** What the office is told when a text could not be placed. */
export const UNROUTABLE_NOTE: Record<InboundUnroutable, string> = {
  UNKNOWN_SENDER: 'from a number that is not a driver on the system',
  NO_OPEN_THREAD: 'with no passenger waiting on an answer',
  AMBIGUOUS:
    'and two passengers had both just asked something, so it was not clear which',
};

/**
 * What the driver is told when a passenger messages them by text.
 *
 * The reference is in it for the human — a driver with two jobs needs to know
 * which — and the instruction is explicit because this is the one path where
 * the driver has no Reply button to press. Everything they send back goes to
 * the passenger, and a driver who does not know that is one sentence away from
 * telling a client something meant for the office.
 *
 * Deliberately short. It is read at a kerb, probably one-handed, and the
 * passenger's own words are the part that matters.
 */
export function smsForDriver(input: {
  reference: string;
  passengerMessage: string;
  company: string;
}): string {
  return [
    `${input.company}: message from your passenger (${input.reference})`,
    '',
    input.passengerMessage,
    '',
    'Reply to this text and they will see it.',
  ].join('\n');
}
