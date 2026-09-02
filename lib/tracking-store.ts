import { randomBytes } from 'node:crypto';
import { etaForJob, type JobEta } from './eta/store';
import { prisma } from './prisma';
import { trackingLinkLive, trackingView, type TrackingView } from './tracking';

/**
 * Issuing and redeeming passenger tracking links.
 *
 * Apart from `lib/tracking.ts` for the usual reason: that module decides what
 * a passenger may see and is pure, and this one reaches Postgres.
 */

/**
 * 24 bytes, matching the name board's and the driver's linking token.
 *
 * The URL is the only thing standing between a stranger and a page naming a
 * passenger's driver, car and pickup address, so guessing has to be hopeless
 * rather than merely unlikely.
 */
const TOKEN_BYTES = 24;

/** Statuses where nobody is being met and a link would say nothing useful. */
const NO_LINK = ['DRAFT'];

/**
 * This job's tracking link, minting one the first time it is asked for.
 *
 * Lazily and then stably, on the name board's reasoning: a passenger who
 * saved the link the night before still has a working page in the morning,
 * and re-sending the booking confirmation does not invalidate the link they
 * are already holding.
 */
export async function issueTrackingToken(
  jobId: string,
): Promise<string | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, trackingToken: true },
  });

  if (!job || NO_LINK.includes(job.status)) return null;
  if (job.trackingToken) return job.trackingToken;

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.job.update({
    where: { id: jobId },
    data: { trackingToken: token },
  });
  return token;
}

/**
 * A fresh link, retiring the old one.
 *
 * The reason the token is a column rather than a signature over the job id:
 * a link forwarded to the wrong person, or left in a group chat, can be taken
 * away. A signature could only be revoked by changing a secret every other
 * link depends on.
 */
export async function reissueTrackingToken(
  jobId: string,
): Promise<string | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true },
  });
  if (!job || NO_LINK.includes(job.status)) return null;

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.job.update({
    where: { id: jobId },
    data: { trackingToken: token },
  });
  return token;
}

export interface TrackingPage {
  reference: string;
  view: TrackingView;
  /** Null unless the view asks for one and there is an honest answer. */
  eta: JobEta | null;
  pickupText: string;
  dropoffText: string;
  scheduledAt: Date;
}

/**
 * The page behind a token, or null.
 *
 * Null covers four different things on purpose — no such token, a job that is
 * soft-deleted, a link outside its window, and a token that was reissued —
 * because telling them apart is exactly what lets somebody with a guessed
 * token learn whether they guessed a real one.
 */
export async function resolveTracking(
  token: string,
  now: Date = new Date(),
): Promise<TrackingPage | null> {
  // Length-checked before the query so a pathological URL is not a database
  // round trip. The token is fixed-width base64url.
  if (!token || token.length > 64) return null;

  const job = await prisma.job.findFirst({
    where: { trackingToken: token },
    select: {
      id: true,
      reference: true,
      status: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
      driver: { select: { name: true } },
      vehicle: {
        select: { make: true, model: true, colour: true, registration: true },
      },
      events: {
        where: { type: { in: ['ON_WAY', 'ARRIVED', 'POB', 'COMPLETED'] } },
        orderBy: { occurredAt: 'desc' },
        take: 1,
        select: { type: true },
      },
    },
  });

  if (!job) return null;
  if (!trackingLinkLive(job.scheduledAt, now)) return null;

  const view = trackingView({
    status: job.status,
    scheduledAt: job.scheduledAt,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    driver: job.driver,
    vehicle: job.vehicle,
    lastEvent: job.events[0]?.type ?? null,
  });

  /*
   * The ETA is fetched only when the view asks for it.
   *
   * Not merely to save the work: `etaForJob` may call a paid routing API, and
   * this page is public and refreshes itself. Computing an estimate nobody is
   * going to be shown would be billed on every poll of every stale link.
   */
  const eta = view.showEta ? await etaForJob(job.id, now) : null;

  return {
    reference: job.reference,
    view,
    eta,
    pickupText: job.pickupText,
    dropoffText: job.dropoffText,
    scheduledAt: job.scheduledAt,
  };
}
