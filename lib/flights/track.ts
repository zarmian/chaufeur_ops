import { recordAudit } from '../audit';
import { formatDateTime } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { prisma } from '../prisma';
import { alertOps } from '../telegram/dispatch';
import { onJobEdited } from '../telegram/hooks';
import {
  decideFlightAdjustment,
  shouldRefresh,
  type FlightFlag,
} from './decide';
import {
  cachedFlight,
  dateParam,
  getFlightConfig,
  providerFor,
  recordFlight,
  recordMiss,
} from './store';
import {
  flightsUsable,
  normaliseFlightNumber,
  type FlightConfig,
  type FlightProvider,
} from './types';

/**
 * One pass over the airport work that is coming up.
 *
 * Find the jobs with a flight number, ask about each distinct flight once,
 * and act on what comes back. It runs on a schedule with nobody watching, so
 * every failure here is a value rather than an exception: one unreachable
 * provider must not take down the run and skip every other flight in it.
 *
 * **It never moves a pickup by itself unless told to.** `autoAdjust` is off
 * by default. With it off, everything below still happens — the flight is
 * looked up, the delay is known, the office is told — and only the rewriting
 * of the booking waits for a person. That is the setting an install should
 * start on, and change once it has watched the flags for a week.
 *
 * When it does move a pickup, it moves it through `onJobEdited`, which is the
 * same path a human edit takes: the driver gets the change message, their job
 * card is refreshed, and the audit log records it as a change made by nobody
 * — which is exactly what happened.
 */

export interface TrackSummary {
  checked: number;
  lookups: number;
  shifted: number;
  flagged: number;
  errors: Array<{ flightNumber: string; message: string }>;
  /** What was decided, for the cron's response and for a human reading it. */
  outcomes: Array<{
    reference: string;
    flightNumber: string;
    action: string;
    flag: FlightFlag | null;
    explanation: string;
  }>;
}

/** Statuses where a pickup time still means something. */
const LIVE = ['DRAFT', 'PENDING', 'ASSIGNED', 'ACCEPTED'] as const;

export interface TrackOptions {
  now?: Date;
  /**
   * The provider to ask.
   *
   * Injected rather than always resolved from the config for the same reason
   * the adapters take a `fetch`: everything in this file except the one HTTP
   * call can be proven against a real database, and it should be. What a
   * stub cannot prove is whether AeroDataBox's payload really looks the way
   * `aerodatabox.ts` believes — that needs a key and one live call.
   */
  provider?: FlightProvider;
}

export async function trackFlights(
  options: TrackOptions = {},
): Promise<TrackSummary> {
  const now = options.now ?? new Date();
  const summary: TrackSummary = {
    checked: 0,
    lookups: 0,
    shifted: 0,
    flagged: 0,
    errors: [],
    outcomes: [],
  };

  const config = await getFlightConfig();
  if (!flightsUsable(config)) return summary;

  const until = new Date(now.getTime() + config.lookAheadHours * 3_600_000);

  const jobs = await prisma.job.findMany({
    where: {
      flightNumber: { not: null },
      // A job already under way has a driver at the kerb; moving its pickup
      // time would rewrite history rather than change a plan.
      status: { in: [...LIVE] },
      scheduledAt: { gte: new Date(now.getTime() - 3_600_000), lte: until },
    },
    select: {
      id: true,
      reference: true,
      scheduledAt: true,
      flightNumber: true,
      flightPickupBaseAt: true,
      flightStatusId: true,
      pickupText: true,
      dropoffText: true,
      passengerName: true,
      driverId: true,
    },
    orderBy: { scheduledAt: 'asc' },
    take: 300,
  });

  /*
   * One lookup per flight, however many cars are meeting it.
   *
   * A family in two cars and two clients off the same New York service are
   * the ordinary cases, and asking three times would be billed three times
   * for one answer.
   */
  const seen = new Map<string, string | null>();

  for (const job of jobs) {
    const flightNumber = normaliseFlightNumber(job.flightNumber);
    if (!flightNumber) continue;

    summary.checked += 1;

    // The provider keys on the flight's own schedule date, which for a
    // red-eye is the day the pickup is on.
    const on = job.scheduledAt;
    const cacheKey = `${flightNumber}:${dateParam(on)}`;

    let statusId = seen.get(cacheKey) ?? null;
    if (!seen.has(cacheKey)) {
      statusId = await refreshFlight(
        config,
        flightNumber,
        on,
        now,
        summary,
        options.provider ?? providerFor(config.provider),
      );
      seen.set(cacheKey, statusId);
    }
    if (!statusId) continue;

    const status = await prisma.flightStatus.findUnique({
      where: { id: statusId },
    });
    if (!status) continue;

    if (job.flightStatusId !== statusId) {
      await prisma.job.update({
        where: { id: job.id },
        data: { flightStatusId: statusId },
      });
    }

    const decision = decideFlightAdjustment({
      pickupAt: job.scheduledAt,
      basePickupAt: job.flightPickupBaseAt,
      flight: {
        flightNumber,
        state: status.state,
        scheduledArrival: status.scheduledArrival,
        estimatedArrival: status.estimatedArrival,
        actualArrival: status.actualArrival,
        origin: status.origin,
        destination: status.destination,
        terminal: status.terminal,
      },
      now,
      minShiftMinutes: config.minShiftMinutes,
      minNoticeMinutes: config.minNoticeMinutes,
    });

    if (decision.action === 'HOLD') continue;

    summary.outcomes.push({
      reference: job.reference,
      flightNumber,
      action: decision.action,
      flag: decision.flag,
      explanation: decision.explanation,
    });

    if (decision.action === 'SHIFT' && config.autoAdjust && decision.pickupAt) {
      await applyShift(job, decision.pickupAt, decision.explanation);
      summary.shifted += 1;
      continue;
    }

    summary.flagged += 1;
    await tellOps(
      job.reference,
      decision.explanation,
      decision.action === 'SHIFT',
    );
  }

  return summary;
}

/** Ask the provider, unless the answer we have is still good enough. */
async function refreshFlight(
  config: FlightConfig,
  flightNumber: string,
  on: Date,
  now: Date,
  summary: TrackSummary,
  provider: FlightProvider,
): Promise<string | null> {
  const cached = await cachedFlight(flightNumber, on);

  if (
    cached &&
    !shouldRefresh({
      checkedAt: cached.checkedAt,
      scheduledArrival: cached.scheduledArrival,
      now,
      refreshMinutes: config.refreshMinutes,
    })
  ) {
    return cached.id;
  }

  summary.lookups += 1;
  const answer = await provider.lookup(config, flightNumber, dateParam(on));

  if (!answer.ok) {
    summary.errors.push({
      flightNumber,
      message: `${answer.code}: ${answer.message}`,
    });
    // Whatever is cached beats nothing: a delay found an hour ago is still
    // truer than pretending the flight is on time.
    return cached?.id ?? null;
  }

  const row = answer.value
    ? await recordFlight(answer.value, on, config.provider, null)
    : await recordMiss(flightNumber, on, config.provider);

  return row.id;
}

/**
 * Move the pickup, the way a person moving it would.
 *
 * Through `onJobEdited` rather than a bare `update`, so the driver gets the
 * change message and their job card is refreshed. A pickup that moved in the
 * database and not on the driver's phone is worse than one that did not move:
 * the office believes the driver has been told.
 */
async function applyShift(
  job: {
    id: string;
    scheduledAt: Date;
    flightPickupBaseAt: Date | null;
    pickupText: string;
    dropoffText: string;
    flightNumber: string | null;
    passengerName: string | null;
  },
  pickupAt: Date,
  explanation: string,
): Promise<void> {
  const before = {
    scheduledAt: job.scheduledAt,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    flightNumber: job.flightNumber,
    passengerName: job.passengerName,
  };

  await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt: pickupAt,
      // Remembered once and never overwritten, so the buffer stays measured
      // from where a person put the pickup rather than from our own last move.
      flightPickupBaseAt: job.flightPickupBaseAt ?? job.scheduledAt,
      flightAdjustedAt: new Date(),
    },
  });

  // A null user, because no member of staff did this. Spelling that out in
  // the log is the difference between "the system moved it" and an operator
  // being asked why they changed a booking they never touched.
  await recordAudit(
    'Job',
    'update',
    job.id,
    { before, after: { ...before, scheduledAt: pickupAt } },
    {},
  );

  await onJobEdited(job.id, before, { ...before, scheduledAt: pickupAt });
  await tellOps(null, explanation, true);
}

/** The office hears about it either way — moved, or waiting for them. */
async function tellOps(
  reference: string | null,
  explanation: string,
  wouldMove: boolean,
): Promise<void> {
  const prefix = reference ? `${reference}: ` : '';
  const tail = wouldMove
    ? ''
    : ' Nothing has been changed — this one needs you.';

  try {
    await alertOps(`${prefix}${explanation}${tail}`);
  } catch {
    // The alert is a courtesy; failing to send one must not abandon the rest
    // of the run, which still has flights to check.
  }
}

/** How a flight reads on the dispatch board and the job screen. */
export async function describeFlight(status: {
  state: string;
  scheduledArrival: Date | null;
  estimatedArrival: Date | null;
  actualArrival: Date | null;
  terminal: string | null;
}): Promise<string> {
  const { locale, timeZone } = await getLocaleConfig();
  const at = (value: Date) => formatDateTime(value, { locale, timeZone });

  if (status.state === 'CANCELLED') return 'Cancelled';
  if (status.state === 'DIVERTED') return 'Diverted';
  if (status.actualArrival) return `Landed ${at(status.actualArrival)}`;
  if (status.estimatedArrival) return `Expected ${at(status.estimatedArrival)}`;
  if (status.scheduledArrival)
    return `Scheduled ${at(status.scheduledArrival)}`;
  return 'No information';
}
