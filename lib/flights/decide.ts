import type { FlightReport, FlightState } from './types';

/**
 * Whether a flight moving should move the car, and by how much.
 *
 * Pure, and separate from both the provider and the database, because this is
 * the part people will argue about afterwards: how late is worth acting on,
 * whether an early landing should pull a driver forward, what happens when a
 * flight is cancelled at four in the morning. Those answers are stated once
 * here and tested exhaustively, rather than being spread through a cron job
 * where nobody can see them.
 *
 * **The buffer is the operator's, not ours.** A booking made for 40 minutes
 * after a scheduled landing is a person's judgement about that airport, that
 * client and that terminal — long enough for bags off a wide-body, short
 * enough that the car is not paid to sit there. So the pickup is never
 * recomputed from a rule of our own: the gap between the *scheduled* arrival
 * and the pickup somebody typed is measured, and preserved against the new
 * arrival. A flight ninety minutes late moves the pickup ninety minutes; it
 * does not move it to some default we invented.
 */

export type FlightAction =
  /** Move the pickup. */
  | 'SHIFT'
  /** Tell somebody. Never move it — a person has to decide. */
  | 'FLAG'
  /** Nothing worth doing. */
  | 'HOLD';

export type FlightFlag =
  /** Landing later than booked for, by more than the threshold. */
  | 'DELAYED'
  /** Landing earlier, and too soon to pull the driver forward safely. */
  | 'EARLY'
  /** Not operating. Nobody is being met. */
  | 'CANCELLED'
  /** Gone to another airport. The pickup address itself is now wrong. */
  | 'DIVERTED'
  /** The provider has no scheduled arrival, so there is no buffer to keep. */
  | 'NO_BASELINE';

export interface FlightDecision {
  action: FlightAction;
  /** Set on SHIFT. The instant the pickup should move to. */
  pickupAt: Date | null;
  /** Signed minutes: positive is later than the current pickup. */
  shiftMinutes: number;
  flag: FlightFlag | null;
  /** One line, written to be read by an operator on a busy morning. */
  explanation: string;
}

export interface FlightDecisionInput {
  /** Where the pickup is now — possibly already moved by an earlier run. */
  pickupAt: Date;
  /**
   * Where a person last put the pickup, if tracking has moved it since.
   *
   * The buffer is measured from this and never from `pickupAt`: measuring
   * from a time this code set would fold each run's adjustment into the next
   * one, and a flight delayed twice would walk the pickup steadily away from
   * the aeroplane.
   */
  basePickupAt?: Date | null;
  flight: FlightReport;
  now: Date;
  minShiftMinutes: number;
  minNoticeMinutes: number;
}

const MINUTE_MS = 60_000;

/** States nobody should act on automatically. */
const HUMAN_REQUIRED: Partial<Record<FlightState, FlightFlag>> = {
  CANCELLED: 'CANCELLED',
  DIVERTED: 'DIVERTED',
};

export function decideFlightAdjustment(
  input: FlightDecisionInput,
): FlightDecision {
  const { flight, now, pickupAt } = input;
  const base = input.basePickupAt ?? pickupAt;

  const humanFlag = HUMAN_REQUIRED[flight.state];
  if (humanFlag) {
    return {
      action: 'FLAG',
      pickupAt: null,
      shiftMinutes: 0,
      flag: humanFlag,
      explanation:
        humanFlag === 'CANCELLED'
          ? `${flight.flightNumber} is cancelled. Nobody is arriving on it.`
          : `${flight.flightNumber} has been diverted. The pickup airport may be wrong.`,
    };
  }

  // No timetable, no buffer, nothing to preserve. Worth saying rather than
  // silently doing nothing: it usually means the flight number is wrong.
  if (!flight.scheduledArrival) {
    return {
      action: 'FLAG',
      pickupAt: null,
      shiftMinutes: 0,
      flag: 'NO_BASELINE',
      explanation: `No timetable found for ${flight.flightNumber}. Check the flight number.`,
    };
  }

  const arrival =
    flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival;

  const bufferMs = base.getTime() - flight.scheduledArrival.getTime();
  const target = new Date(arrival.getTime() + bufferMs);
  const shiftMinutes = Math.round(
    (target.getTime() - pickupAt.getTime()) / MINUTE_MS,
  );

  if (Math.abs(shiftMinutes) < input.minShiftMinutes) {
    return {
      action: 'HOLD',
      pickupAt: null,
      shiftMinutes,
      flag: null,
      explanation: `${flight.flightNumber} is running to time.`,
    };
  }

  const lateness = describeMinutes(Math.abs(shiftMinutes));

  if (shiftMinutes > 0) {
    return {
      action: 'SHIFT',
      pickupAt: target,
      shiftMinutes,
      flag: 'DELAYED',
      explanation: `${flight.flightNumber} is ${lateness} late. Pickup moves back ${lateness}.`,
    };
  }

  /*
   * Early. Good news, unless the answer is to tell a driver already on their
   * way that they should have left earlier.
   *
   * Notice is measured to the *new* pickup, which is the moment somebody
   * would actually have to be there. Anything inside the window is flagged
   * for a person, who can ring the driver — something this cannot do.
   */
  const noticeMinutes = (target.getTime() - now.getTime()) / MINUTE_MS;
  if (noticeMinutes < input.minNoticeMinutes) {
    return {
      action: 'FLAG',
      pickupAt: target,
      shiftMinutes,
      flag: 'EARLY',
      explanation: `${flight.flightNumber} is ${lateness} early — too close to move the pickup automatically.`,
    };
  }

  return {
    action: 'SHIFT',
    pickupAt: target,
    shiftMinutes,
    flag: 'EARLY',
    explanation: `${flight.flightNumber} is ${lateness} early. Pickup moves forward ${lateness}.`,
  };
}

/** "1 hour 35 minutes", not "95 minutes" — it is read aloud down a phone. */
export function describeMinutes(minutes: number): string {
  const whole = Math.abs(Math.round(minutes));
  if (whole < 60) return `${whole} minute${whole === 1 ? '' : 's'}`;

  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  if (rest === 0) return hourPart;
  return `${hourPart} ${rest} minute${rest === 1 ? '' : 's'}`;
}

/**
 * Whether a flight is worth asking about again yet.
 *
 * Every lookup is billed, and a flight three days out has nothing to say that
 * the timetable did not. Close in, it has everything to say.
 */
export function shouldRefresh(input: {
  checkedAt: Date | null;
  scheduledArrival: Date | null;
  now: Date;
  refreshMinutes: number;
}): boolean {
  if (!input.checkedAt) return true;

  const sinceMinutes =
    (input.now.getTime() - input.checkedAt.getTime()) / MINUTE_MS;
  if (sinceMinutes >= input.refreshMinutes) return true;

  /*
   * The last hour before landing, where an estimate can move by twenty
   * minutes between one look and the next — and where a stale answer is the
   * one that puts a driver in the wrong place.
   */
  if (input.scheduledArrival) {
    const untilArrival =
      (input.scheduledArrival.getTime() - input.now.getTime()) / MINUTE_MS;
    if (untilArrival > -30 && untilArrival < 60) {
      return sinceMinutes >= Math.min(input.refreshMinutes, 5);
    }
  }

  return false;
}
