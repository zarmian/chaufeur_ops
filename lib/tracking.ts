/**
 * What the passenger is shown, and what they are not.
 *
 * The page behind a tracking link has no login. It is opened by whoever holds
 * the URL — the passenger, the assistant who booked for them, a WhatsApp
 * group, eventually a search engine if somebody pastes it somewhere public.
 * So the question this module answers is not "what do we know about the job"
 * but "what is safe to put in front of a stranger holding the link", and the
 * two are very different lists.
 *
 * **Withheld, always.** The client's price and the driver's fee — a passenger
 * who can see both can see the margin, and a booker who forwards the link has
 * handed a competitor the rate card. The driver's phone number, because a
 * link that outlives the job would leave an owner-driver's mobile on the
 * internet. Every other passenger on the day. Notes, which are written by
 * staff for staff.
 *
 * **Shown.** Enough to stop somebody ringing the office: whether a car is
 * coming, who is driving, what they are driving, and how far away they are.
 *
 * Pure, so every one of those decisions is a test rather than a judgement
 * made while writing a template.
 */

/** Where the job is, from the passenger's point of view rather than ops'. */
export type TrackingStage =
  /** Booked, nobody assigned yet. */
  | 'BOOKED'
  /** A driver is on it, but not yet moving. */
  | 'ASSIGNED'
  /** On their way to the pickup. */
  | 'ON_WAY'
  /** At the pickup, waiting. */
  | 'ARRIVED'
  /** Passenger on board. */
  | 'IN_PROGRESS'
  /** Finished. */
  | 'COMPLETED'
  /** Cancelled. */
  | 'CANCELLED';

export interface TrackingJob {
  status: string;
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  driver: { name: string } | null;
  vehicle: {
    make: string | null;
    model: string | null;
    colour: string | null;
    registration: string;
  } | null;
  /** The most recent status event, which is finer-grained than `status`. */
  lastEvent: string | null;
}

export interface TrackingView {
  stage: TrackingStage;
  /** The single line at the top of the page. */
  headline: string;
  /** One sentence under it. Empty when the headline says everything. */
  detail: string;
  driverName: string | null;
  /** "Black Mercedes-Benz S-Class · AB12 CDE", or null when unassigned. */
  vehicle: string | null;
  /** Whether a live ETA is worth showing at this stage. */
  showEta: boolean;
  /** Whether the page should keep refreshing itself. */
  live: boolean;
}

/**
 * How long before the pickup the driver is named.
 *
 * The link works from the moment it is issued — a passenger checking the night
 * before is doing exactly what it is for — but until two hours out it says
 * that a car is booked and nothing about who is driving it.
 *
 * Two reasons, and the second is the one that matters. A crew can change: name
 * a driver at nine in the morning for a six o'clock pickup and any swap
 * afterwards is a passenger looking for the wrong person. And a link is
 * forwarded — the fewer hours an owner-driver's name and registration sit in
 * somebody's group chat, the better.
 */
export const DRIVER_SHOWN_HOURS = 2;

export function driverShown(scheduledAt: Date, now: Date = new Date()): boolean {
  return (
    now.getTime() >= scheduledAt.getTime() - DRIVER_SHOWN_HOURS * 3_600_000
  );
}

/** What the page says while the crew is still being held back. */
const WAIT_FOR_CREW =
  'Your driver and car will appear here two hours before your pickup.';

/**
 * `IN_PROGRESS` covers three different things a passenger cares about
 * distinctly: the driver setting off, arriving, and the journey itself. The
 * job's own status cannot tell them apart — the events can.
 */
function stageOf(job: TrackingJob): TrackingStage {
  if (job.status === 'CANCELLED' || job.status === 'NO_SHOW')
    return 'CANCELLED';
  if (job.status === 'COMPLETED') return 'COMPLETED';

  if (job.lastEvent === 'POB') return 'IN_PROGRESS';
  if (job.lastEvent === 'ARRIVED') return 'ARRIVED';
  if (job.lastEvent === 'ON_WAY') return 'ON_WAY';

  if (job.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (job.driver) return 'ASSIGNED';
  return 'BOOKED';
}

/**
 * The car, as a passenger standing on a pavement would describe it.
 *
 * Colour first, because that is what somebody scanning a line of cars sees
 * before they can read a badge, let alone a numberplate. Missing parts are
 * dropped rather than filled with "Unknown", which reads as a fault.
 */
export function describeVehicle(
  vehicle: TrackingJob['vehicle'],
): string | null {
  if (!vehicle) return null;

  const description = [vehicle.colour, vehicle.make, vehicle.model]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');

  return description
    ? `${description} · ${vehicle.registration}`
    : vehicle.registration;
}

export function trackingView(
  job: TrackingJob,
  now: Date = new Date(),
): TrackingView {
  const stage = stageOf(job);

  /*
   * The crew, once it is theirs to know.
   *
   * Withheld before the two-hour mark even when a driver has been assigned for
   * days — see `DRIVER_SHOWN_HOURS`. Held back together, because a car with no
   * driver beside it is the same puzzle for a passenger as a driver with no
   * car: both invite the call this page exists to prevent.
   */
  const shown = driverShown(job.scheduledAt, now);
  const vehicle = shown ? describeVehicle(job.vehicle) : null;
  const driverName = shown ? (job.driver?.name ?? null) : null;

  const common = { stage, driverName, vehicle };

  switch (stage) {
    case 'CANCELLED':
      return {
        ...common,
        headline: 'This journey has been cancelled',
        detail: 'Please contact the office if you were not expecting this.',
        // Nothing about a car is relevant any more, and showing a driver
        // beside "cancelled" reads as though one is still coming.
        driverName: null,
        vehicle: null,
        showEta: false,
        live: false,
      };

    case 'COMPLETED':
      return {
        ...common,
        headline: 'Journey complete',
        detail: 'Thank you for travelling with us.',
        showEta: false,
        live: false,
      };

    case 'IN_PROGRESS':
      return {
        ...common,
        headline: 'On your way',
        detail: `Heading to ${job.dropoffText}.`,
        // The ETA on this page is the ETA to the *pickup*, which is behind
        // them now. Showing it during the journey would count down to a place
        // they have already left.
        showEta: false,
        live: true,
      };

    case 'ARRIVED':
      return {
        ...common,
        headline: 'Your car is here',
        detail: vehicle
          ? `Look for ${vehicle}.`
          : 'Your driver is at the pickup point.',
        showEta: false,
        live: true,
      };

    case 'ON_WAY':
      return {
        ...common,
        headline: 'Your driver is on the way',
        detail: '',
        showEta: true,
        live: true,
      };

    case 'ASSIGNED':
      return {
        ...common,
        headline: 'Your car is booked',
        // Deliberately no ETA. A driver who has not set off has a last known
        // position that is their home, their previous job, or nowhere at all,
        // and "42 minutes away" computed from it is a number the passenger
        // will hold us to.
        detail: shown
          ? 'Your driver will set off in good time.'
          : WAIT_FOR_CREW,
        showEta: false,
        live: true,
      };

    case 'BOOKED':
      return {
        ...common,
        headline: 'Your car is booked',
        // Says *when* rather than "shortly", because a passenger who checks
        // the night before and reads "shortly" checks again in ten minutes.
        detail: shown ? 'Your driver will be confirmed shortly.' : WAIT_FOR_CREW,
        showEta: false,
        live: true,
      };
  }
}

/**
 * Whether a link should still answer at all.
 *
 * A tracking link is not a receipt. Once the journey is over it is a page
 * naming a driver, a car and two addresses, sitting in whatever chat it was
 * forwarded into — so it stops being useful the moment the passenger is set
 * down, and that is when it closes.
 *
 * **The journey ending is what closes it**, not a clock. The moment the driver
 * taps Completed the page stops answering and the thread on it goes too. That
 * is more precise than a fixed window and it is also kinder: a journey running
 * three hours late keeps working the whole time, where a window would have
 * shut in the middle of it.
 *
 * **A cancellation is the exception, and deliberately.** A job called off an
 * hour before the pickup leaves somebody standing on a pavement, and "no car
 * is coming" is the single most valuable thing this page ever says — closing
 * the link at that moment would take away the answer they most need and send
 * them to the phone instead, which is the call the page exists to prevent.
 * The cancelled view names no driver and no car, so a link that keeps
 * answering carries nothing a finished one would not. It closes at the
 * backstop like anything else.
 *
 * **The clock is only a backstop.** A driver who forgets to tap Completed
 * would otherwise leave the page live for ever, and "for ever" is the one
 * answer a forwarded link naming somebody's driver must never have. Generous,
 * because a flight can land four hours late and the backstop must never be
 * what ends a journey that is genuinely still running.
 */
export const TRACKING_BACKSTOP_HOURS = 12;

/** Statuses that mean the journey happened and is behind everybody. */
const FINISHED = ['COMPLETED', 'NO_SHOW'];

export function trackingLinkLive(
  job: { status: string; scheduledAt: Date },
  now: Date = new Date(),
): boolean {
  if (FINISHED.includes(job.status)) return false;

  const backstop =
    job.scheduledAt.getTime() + TRACKING_BACKSTOP_HOURS * 3_600_000;
  return now.getTime() <= backstop;
}
