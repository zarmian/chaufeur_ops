import { billableWaitMinutes, freeWaitMinutesFor } from './job-finance';

/**
 * Turning the gap between two taps into money — spec 5.5.
 *
 * Wait time is revenue the legacy system never billed, because nobody was
 * standing at the kerb with a stopwatch. The driver's `ARRIVED` and `POB`
 * taps are that stopwatch, and this is the arithmetic between them.
 *
 * Pure, and separate from the bot: the events could come from anywhere — a
 * dispatcher correcting a timestamp, an import — and the rule for what counts
 * as billable must not depend on how they arrived.
 */

export interface WaitInput {
  arrivedAt: Date | null;
  pobAt: Date | null;
  /** From the matched rate card rule, where there is one. */
  freeWaitMinutes?: number | null;
  waitPerMinutePence?: number | null;
  /** Falls back to the per-job-type default when no rule matched. */
  jobType: string;
  freeWaitDefaults?: { airport?: number; other?: number };
}

export interface WaitCalculation {
  /** Null when the events do not support a calculation. */
  waitedMinutes: number | null;
  freeMinutes: number;
  billableMinutes: number;
  perMinutePence: number;
  pence: number;
  /** Shown beside the figure, so nobody has to trust it blindly. */
  explanation: string;
  /** True when there is a figure worth writing. */
  calculable: boolean;
}

/**
 * What the wait on this job is worth.
 *
 * Refuses rather than guesses when the events are missing or inverted. A
 * driver who forgot to tap `ARRIVED` has not waited zero minutes — the truth
 * is unknown, and writing a zero would quietly bill nothing for a two-hour
 * wait and give nobody a reason to look.
 */
export function calculateWait(input: WaitInput): WaitCalculation {
  const freeMinutes =
    input.freeWaitMinutes ?? freeWaitMinutesFor(input.jobType, input.freeWaitDefaults ?? {});
  const perMinutePence = input.waitPerMinutePence ?? 0;

  const blank = (explanation: string): WaitCalculation => ({
    waitedMinutes: null,
    freeMinutes,
    billableMinutes: 0,
    perMinutePence,
    pence: 0,
    explanation,
    calculable: false,
  });

  if (!input.arrivedAt) {
    return blank('No Arrived tap, so the wait cannot be worked out.');
  }
  if (!input.pobAt) {
    return blank('No Passenger on board tap yet.');
  }

  const waitedMs = input.pobAt.getTime() - input.arrivedAt.getTime();
  if (waitedMs < 0) {
    // Corrected timestamps, or a driver tapping out of order and ops
    // repairing it afterwards. Either way it is not a negative wait.
    return blank('Passenger on board is recorded before Arrived — check the timeline.');
  }

  // Floored, not rounded: billing a minute nobody waited is the kind of
  // thing a client notices once and remembers for a year.
  const waitedMinutes = Math.floor(waitedMs / 60_000);
  const billableMinutes = billableWaitMinutes(waitedMinutes, freeMinutes);
  const pence = billableMinutes * perMinutePence;

  return {
    waitedMinutes,
    freeMinutes,
    billableMinutes,
    perMinutePence,
    pence,
    explanation: explain(waitedMinutes, freeMinutes, billableMinutes, perMinutePence),
    calculable: true,
  };
}

function explain(
  waited: number,
  free: number,
  billable: number,
  perMinute: number,
): string {
  const waitedText = `Waited ${waited} min, ${free} min free`;

  if (billable === 0) {
    return `${waitedText} — nothing to charge.`;
  }
  if (perMinute === 0) {
    return `${waitedText}, ${billable} billable — but the rate card charges nothing per minute.`;
  }
  return `${waitedText}, ${billable} × ${(perMinute / 100).toFixed(2)} per min.`;
}

/**
 * The two timestamps, from a job's events.
 *
 * The *first* of each rather than the last: a driver who taps Arrived twice
 * arrived once, and taking the later tap would shorten a wait they really
 * had. `POB` takes the first for the same reason in reverse.
 */
export function waitTimestamps(
  events: ReadonlyArray<{ type: string; occurredAt: Date }>,
): { arrivedAt: Date | null; pobAt: Date | null } {
  let arrivedAt: Date | null = null;
  let pobAt: Date | null = null;

  for (const event of events) {
    if (event.type === 'ARRIVED' && (!arrivedAt || event.occurredAt < arrivedAt)) {
      arrivedAt = event.occurredAt;
    }
    if (event.type === 'POB' && (!pobAt || event.occurredAt < pobAt)) {
      pobAt = event.occurredAt;
    }
  }

  return { arrivedAt, pobAt };
}
