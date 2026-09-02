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

export function trackingView(job: TrackingJob): TrackingView {
  const stage = stageOf(job);
  const vehicle = describeVehicle(job.vehicle);
  const driverName = job.driver?.name ?? null;

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
        detail: 'Your driver will set off in good time.',
        showEta: false,
        live: true,
      };

    case 'BOOKED':
      return {
        ...common,
        headline: 'Your car is booked',
        detail: 'Your driver will be confirmed shortly.',
        showEta: false,
        live: true,
      };
  }
}

/**
 * Whether a link should still answer at all.
 *
 * A tracking link is not a receipt. Hours after the journey it is a page
 * naming a driver, a car and two addresses, sitting in whatever chat it was
 * forwarded into — so it stops being useful long before it stops being
 * sensitive, and the cheapest way to close that gap is to let it expire.
 *
 * Generous either side of the booking: a flight can land four hours late, and
 * a passenger checking the night before is doing exactly what the link is for.
 */
export const TRACKING_OPENS_HOURS = 24;
export const TRACKING_CLOSES_HOURS = 6;

export function trackingLinkLive(
  scheduledAt: Date,
  now: Date = new Date(),
): boolean {
  const opens = scheduledAt.getTime() - TRACKING_OPENS_HOURS * 3_600_000;
  const closes = scheduledAt.getTime() + TRACKING_CLOSES_HOURS * 3_600_000;
  return now.getTime() >= opens && now.getTime() <= closes;
}
