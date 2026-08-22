/**
 * What the bot says, and what a tap means.
 *
 * Pure: no grammY, no database, no network. Everything here can be tested
 * from a fixture, which matters more than usual because the alternative is
 * testing against Telegram — and the parts most likely to be wrong are the
 * ones a live test would be worst at catching: the order status taps are
 * allowed in, and what a callback string means when it comes back hours
 * later attached to a job that has since moved on.
 */

export type BotName = 'ops' | 'admin';

/**
 * The status taps a driver makes, in the only order they make sense.
 *
 * Not the same list as `JobStatus`: a driver never sets `PENDING` or
 * `CANCELLED`, and `ON_WAY` is a driver event that happens to move the job.
 */
export const DRIVER_STEPS = ['ON_WAY', 'ARRIVED', 'POB', 'COMPLETED'] as const;
export type DriverStep = (typeof DRIVER_STEPS)[number];

export const STEP_LABELS: Record<DriverStep, string> = {
  ON_WAY: 'On my way',
  ARRIVED: 'Arrived',
  POB: 'Passenger on board',
  COMPLETED: 'Completed',
};

/**
 * The step that should be offered next, given what has already happened.
 *
 * Driven by the events actually recorded rather than by the job's status,
 * because the two can disagree: ops can move a job to `IN_PROGRESS` from the
 * dashboard without the driver having tapped anything, and the driver's
 * keyboard should still ask for the tap that is missing.
 */
export function nextStep(recorded: readonly string[]): DriverStep | null {
  for (const step of DRIVER_STEPS) {
    if (!recorded.includes(step)) return step;
  }
  return null;
}

export type StepVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether a tap is allowed.
 *
 * Out of sequence is refused with an explanation rather than silently
 * ignored, because the driver is standing in an airport car park wondering
 * whether the button worked. A repeat of a step already recorded is *not* an
 * error — Telegram redelivers, and a driver double-taps — so it is accepted
 * quietly and changes nothing.
 */
export function canTake(
  step: DriverStep,
  recorded: readonly string[],
): StepVerdict {
  if (recorded.includes('COMPLETED')) {
    return { ok: false, reason: 'This job is already finished.' };
  }

  if (recorded.includes(step)) {
    // Already done. Not a mistake worth a telling-off.
    return { ok: true };
  }

  const expected = nextStep(recorded);
  if (expected === step) return { ok: true };

  if (!expected) return { ok: false, reason: 'This job is already finished.' };

  return {
    ok: false,
    reason: `Tap ${STEP_LABELS[expected]} first.`,
  };
}

/**
 * Callback data.
 *
 * Telegram allows 64 bytes, which a cuid job id and a verb fit inside with
 * room to spare. Parsed defensively: a button tapped from a message six
 * months old arrives exactly like a fresh one.
 */
export type Callback =
  | { kind: 'accept'; jobId: string }
  | { kind: 'decline'; jobId: string }
  | { kind: 'step'; jobId: string; step: DriverStep }
  | { kind: 'expense-kind'; expenseId: string; expenseKind: string }
  | { kind: 'expense-cancel'; expenseId: string };

export function encodeCallback(callback: Callback): string {
  switch (callback.kind) {
    case 'accept':
      return `job:${callback.jobId}:accept`;
    case 'decline':
      return `job:${callback.jobId}:decline`;
    case 'step':
      return `job:${callback.jobId}:${callback.step.toLowerCase()}`;
    case 'expense-kind':
      return `exp:${callback.expenseId}:${callback.expenseKind.toLowerCase()}`;
    case 'expense-cancel':
      return `exp:${callback.expenseId}:cancel`;
  }
}

const STEP_BY_VERB = new Map<string, DriverStep>(
  DRIVER_STEPS.map((step) => [step.toLowerCase(), step]),
);

export function decodeCallback(data: string): Callback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, id, verb] = parts as [string, string, string];
  if (!id || !verb) return null;

  if (prefix === 'job') {
    if (verb === 'accept') return { kind: 'accept', jobId: id };
    if (verb === 'decline') return { kind: 'decline', jobId: id };
    const step = STEP_BY_VERB.get(verb);
    return step ? { kind: 'step', jobId: id, step } : null;
  }

  if (prefix === 'exp') {
    if (verb === 'cancel') return { kind: 'expense-cancel', expenseId: id };
    return { kind: 'expense-kind', expenseId: id, expenseKind: verb.toUpperCase() };
  }

  return null;
}

/**
 * The link token in a `/start` payload.
 *
 * `drv_<token>` rather than a bare token, so a `/start` with something else
 * in it — a referral code, a stray paste — is recognised as not-a-link rather
 * than looked up and reported as expired.
 */
export function linkPayload(token: string): string {
  return `drv_${token}`;
}

export function parseStartPayload(text: string): string | null {
  const match = /^\/start(?:@\w+)?\s+drv_([A-Za-z0-9_-]{8,128})\s*$/.exec(text.trim());
  return match ? match[1]! : null;
}

/**
 * An amount typed into a chat.
 *
 * A driver types `12.50`, `£12.50`, `12,50` or `12`. Returns pence, or null —
 * never a zero, because a zero-value expense is indistinguishable from a
 * parse failure and would go into the payout as nothing.
 */
export function parseAmountFromChat(input: string): number | null {
  const text = input.trim().replace(/[£$€\s]/g, '');
  if (text === '') return null;

  // A comma as the decimal separator, which a phone keyboard offers in
  // several locales. Only when it is followed by exactly two digits and
  // there is no dot — `1,234.50` is a thousands separator, not a decimal.
  const normalised = /^\d+,\d{2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');

  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;

  const pence = Math.round(Number(normalised) * 100);
  if (!Number.isFinite(pence) || pence <= 0) return null;
  return pence;
}

/**
 * Telegram's own escaping, for MarkdownV2.
 *
 * An unescaped underscore in a passenger's name breaks the whole message, and
 * Telegram's failure mode is to reject it — so the driver gets nothing at all
 * rather than a slightly odd-looking brief.
 */
export function escapeMarkdown(input: string): string {
  return input.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (char) => `\\${char}`);
}

/**
 * A URL, safe to sit inside MarkdownV2's `(...)`.
 *
 * Only two characters can break a link destination — the closing bracket and
 * the backslash — and unlike the text half, everything else is taken
 * literally. Running a URL through `escapeMarkdown` would mangle it: every
 * dot and hyphen in the hostname would come back with a backslash in front of
 * it, and the link would 404.
 */
export function escapeMarkdownUrl(url: string): string {
  return url.replace(/[)\\]/g, (char) => `\\${char}`);
}

export interface JobBrief {
  reference: string;
  when: string;
  pickup: string;
  dropoff: string;
  passenger: string | null;
  vehicle: string | null;
  flightNumber: string | null;
  notes: string | null;
  driverPay: string | null;
  /**
   * The meet-and-greet board, as a full URL.
   *
   * Airport transfers only, and only when a passenger is named. This is the
   * one channel that reaches a driver — they have no login — so a board they
   * cannot open from here is a board that does not exist as far as they are
   * concerned.
   */
  nameBoardUrl?: string | null;
  /** Steps already recorded, so the brief can show progress. */
  recorded?: readonly string[];
}

/**
 * The job as the driver reads it on a phone, at night, in a car park.
 *
 * Ordered by what they need first. The reference is at the top because it is
 * what they will quote on the phone; the pay is at the bottom because it is
 * the thing they will scroll for anyway.
 *
 * Deliberately not including the client's name — the passenger's is what
 * matters at the kerb, and the commercial relationship is not the driver's
 * business.
 */
export function renderBrief(brief: JobBrief): string {
  const lines = [
    `*${escapeMarkdown(brief.reference)}*`,
    `🕒 ${escapeMarkdown(brief.when)}`,
    `📍 ${escapeMarkdown(brief.pickup)}`,
    `🏁 ${escapeMarkdown(brief.dropoff)}`,
  ];

  if (brief.flightNumber) lines.push(`✈️ ${escapeMarkdown(brief.flightNumber)}`);
  if (brief.passenger) lines.push(`👤 ${escapeMarkdown(brief.passenger)}`);
  if (brief.vehicle) lines.push(`🚗 ${escapeMarkdown(brief.vehicle)}`);
  if (brief.notes) lines.push(`📝 ${escapeMarkdown(brief.notes)}`);
  if (brief.driverPay) lines.push(`💷 ${escapeMarkdown(brief.driverPay)}`);

  /*
   * Directly under the passenger's name would be tidier and is wrong: a
   * driver skimming this in a car park reads top to bottom and stops at the
   * first thing they need. The board is the *last* thing they need, at the
   * kerb, twenty minutes after everything above it.
   *
   * A labelled link rather than a bare URL, so it survives being forwarded
   * and still says what it is.
   */
  if (brief.nameBoardUrl) {
    lines.push(`🪧 [Name board](${escapeMarkdownUrl(brief.nameBoardUrl)})`);
  }

  const done = (brief.recorded ?? []).filter((step): step is DriverStep =>
    (DRIVER_STEPS as readonly string[]).includes(step),
  );
  if (done.length > 0) {
    lines.push('');
    lines.push(done.map((step) => `✅ ${escapeMarkdown(STEP_LABELS[step])}`).join('\n'));
  }

  return lines.join('\n');
}

/** What changed on a job the driver has already accepted — spec 5.3.7. */
export function renderChanges(
  reference: string,
  changes: Array<{ field: string; from: string; to: string }>,
): string {
  if (changes.length === 0) return '';

  const lines = [
    `⚠️ *${escapeMarkdown(reference)} has changed*`,
    '',
    ...changes.map(
      (change) =>
        `${escapeMarkdown(change.field)}: ${escapeMarkdown(change.from)} → *${escapeMarkdown(change.to)}*`,
    ),
  ];
  return lines.join('\n');
}
