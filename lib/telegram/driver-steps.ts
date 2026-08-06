import { recordAudit } from '../audit';
import { transitionJob } from '../jobs';
import { prisma } from '../prisma';
import { calculateWait, waitTimestamps, type WaitCalculation } from '../wait-time';
import { canTake, type DriverStep } from './protocol';

/**
 * What happens when a driver taps a status button — spec 5.4 and 5.5.
 *
 * The important decision in this file concerns the Completed tap.
 *
 * `COMPLETED` is refused on an unpriced job, and rightly: a job reaching the
 * end of its life worth nothing is the defect this whole rebuild exists to
 * end. But the driver cannot price it, and refusing the tap would leave them
 * standing on a pavement with a button that does not work.
 *
 * So the two are separated. The `COMPLETED` **event** is always recorded —
 * the driver did finish, and that is a fact about the world. The **status**
 * transition is attempted, and where it is refused the job stays where it is,
 * the driver is told the office will finish it off, and ops is told there is
 * something to price. Neither rule bends.
 */

/** Which taps move the job, and which are only events on the timeline. */
const STEP_STATUS: Record<DriverStep, 'IN_PROGRESS' | 'COMPLETED' | null> = {
  ON_WAY: 'IN_PROGRESS',
  // Arrived and POB happen inside IN_PROGRESS. They are the two that matter
  // most for money, and neither is a status.
  ARRIVED: null,
  POB: null,
  COMPLETED: 'COMPLETED',
};

export interface StepOutcome {
  ok: boolean;
  /** Shown to the driver on the button's toast. */
  message: string;
  /** True when the tap was refused rather than applied. */
  refused: boolean;
  /** Set when ops needs telling — an unpriced job that cannot complete. */
  opsAlert?: string;
  wait?: WaitCalculation;
  /** Every driver step recorded after this tap, for redrawing the message. */
  recorded: string[];
}

/**
 * Apply a tap.
 *
 * Idempotent by design. Telegram redelivers an update whose response it did
 * not see, and a driver in a hurry double-taps: a second `ARRIVED` must not
 * move the clock, because the gap between `ARRIVED` and `POB` is money.
 */
export async function applyStep(
  jobId: string,
  step: DriverStep,
  driverId: string,
  options: { at?: Date; lat?: number | null; lng?: number | null } = {},
): Promise<StepOutcome> {
  const occurredAt = options.at ?? new Date();

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      status: true,
      driverId: true,
      jobType: true,
      rateCardRule: {
        select: { freeWaitMinutes: true, waitPerMinutePence: true },
      },
      events: {
        select: { type: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      },
    },
  });

  if (!job) {
    return { ok: false, refused: true, message: 'That job no longer exists.', recorded: [] };
  }

  // A job reassigned while the driver's phone was in their pocket. The old
  // driver's buttons still work as far as Telegram is concerned.
  if (job.driverId !== driverId) {
    return {
      ok: false,
      refused: true,
      message: 'This job is no longer yours. Check with the office.',
      recorded: recordedSteps(job.events),
    };
  }

  const recorded = recordedSteps(job.events);
  const verdict = canTake(step, recorded);
  if (!verdict.ok) {
    return { ok: false, refused: true, message: verdict.reason, recorded };
  }

  // Already recorded: accepted quietly, changes nothing.
  if (recorded.includes(step)) {
    return {
      ok: true,
      refused: false,
      message: 'Already recorded.',
      recorded,
    };
  }

  await prisma.jobEvent.create({
    data: {
      jobId,
      type: step,
      actorType: 'DRIVER',
      actorId: driverId,
      occurredAt,
      lat: options.lat ?? null,
      lng: options.lng ?? null,
    },
  });

  const nowRecorded = [...recorded, step];

  // Wait time, the moment the passenger is on board — spec 5.5.1.
  const wait =
    step === 'POB'
      ? await recordWait(job.id, job.jobType, job.rateCardRule, [
          ...job.events,
          { type: step, occurredAt },
        ])
      : undefined;

  const wantedStatus = STEP_STATUS[step];
  if (!wantedStatus) {
    return {
      ok: true,
      refused: false,
      message: confirmation(step, wait),
      recorded: nowRecorded,
      ...(wait ? { wait } : {}),
    };
  }

  // Already there — ops moved it from the dashboard. Nothing to do, and not
  // a failure.
  if (job.status === wantedStatus) {
    return {
      ok: true,
      refused: false,
      message: confirmation(step, wait),
      recorded: nowRecorded,
      ...(wait ? { wait } : {}),
    };
  }

  const moved = await transitionJob(jobId, wantedStatus, {
    userId: null,
    ip: null,
  });

  if (moved.ok) {
    return {
      ok: true,
      refused: false,
      message: confirmation(step, wait),
      recorded: nowRecorded,
      ...(wait ? { wait } : {}),
    };
  }

  // The event stands; the status does not. Documented at the top of this
  // file: the driver did finish, and the money guard still holds.
  await recordAudit('Job', 'update', jobId, {
    after: {
      driverStep: step,
      statusUnchanged: job.status,
      reason: moved.message,
    },
  });

  return {
    ok: true,
    refused: false,
    message:
      wantedStatus === 'COMPLETED'
        ? 'Thanks — recorded. The office will finish this one off.'
        : confirmation(step, wait),
    recorded: nowRecorded,
    ...(wait ? { wait } : {}),
    opsAlert: `${job.reference}: driver tapped ${step.replace('_', ' ').toLowerCase()} but the job could not move — ${moved.message}`,
  };
}

/**
 * Write the wait charge onto the job's finance row.
 *
 * Upserted, because a job priced at booking may have no finance row yet, and
 * a wait nobody can bill because nobody opened the settlement screen is
 * exactly the revenue this feature exists to stop losing.
 *
 * Never overwrites a figure an accountant has already overridden — spec
 * 5.5.4. Their reason for changing it is better than this arithmetic.
 */
async function recordWait(
  jobId: string,
  jobType: string,
  rule: { freeWaitMinutes: number; waitPerMinutePence: number } | null,
  events: ReadonlyArray<{ type: string; occurredAt: Date }>,
): Promise<WaitCalculation> {
  const { arrivedAt, pobAt } = waitTimestamps(events);

  const wait = calculateWait({
    arrivedAt,
    pobAt,
    jobType,
    freeWaitMinutes: rule?.freeWaitMinutes ?? null,
    waitPerMinutePence: rule?.waitPerMinutePence ?? null,
  });

  if (!wait.calculable) return wait;

  const existing = await prisma.jobFinance.findUnique({
    where: { jobId },
    select: { waitOverriddenById: true },
  });

  if (existing?.waitOverriddenById) return wait;

  await prisma.jobFinance.upsert({
    where: { jobId },
    update: {
      waitTimePence: wait.pence,
      waitMinutesBilled: wait.billableMinutes,
      waitAutoCalculatedAt: new Date(),
    },
    create: {
      jobId,
      waitTimePence: wait.pence,
      waitMinutesBilled: wait.billableMinutes,
      waitAutoCalculatedAt: new Date(),
    },
  });

  return wait;
}

function confirmation(step: DriverStep, wait?: WaitCalculation): string {
  switch (step) {
    case 'ON_WAY':
      return 'On your way — thanks.';
    case 'ARRIVED':
      return 'Arrival recorded. Waiting time starts now.';
    case 'POB':
      // Spec 5.5.6 — the driver is told what was recorded, so a wait they
      // know was longer gets queried the same day rather than never.
      return wait?.calculable
        ? `Passenger on board. ${wait.waitedMinutes} min wait recorded.`
        : 'Passenger on board.';
    case 'COMPLETED':
      return 'Job completed — thanks.';
  }
}

function recordedSteps(
  events: ReadonlyArray<{ type: string }>,
): string[] {
  return events.map((event) => event.type);
}
