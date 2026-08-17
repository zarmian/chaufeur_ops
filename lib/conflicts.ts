/**
 * Two jobs that cannot both happen — spec 6.2.
 *
 * The existing `findDriverConflicts` asked a cruder question: is there another
 * job within N minutes of this pickup? That catches the obvious clashes and
 * misses the ones that matter. A four-hour as-directed hire starting at nine
 * does not clash with a nine-thirty pickup by that measure — the pickups are
 * half an hour apart — but the driver is plainly in two places at once.
 *
 * So this works in intervals. Each job occupies from its pickup until its
 * pickup plus however long it is expected to take, and a travel buffer is
 * added either side because a driver finishing in Mayfair cannot start in
 * Heathrow the same minute.
 *
 * Everything here is a **warning**. Two airport runs ninety minutes apart may
 * be perfectly workable, and the operator knows the traffic and the driver
 * where the system does not. Blocking would teach people to route around the
 * system, which is how the legacy spreadsheet happened.
 *
 * Pure — no database — so the arithmetic can be tested from fixtures.
 */

/** How long a job with no estimate is assumed to take. */
export const ASSUMED_MINUTES = 60;

export interface Occupies {
  id: string;
  scheduledAt: Date;
  /** Null falls back to `ASSUMED_MINUTES`. */
  estimatedMinutes?: number | null;
  /** Set for an as-directed hire, where the hours are the duration. */
  customerHours?: number | null;
  /**
   * A contract day. Excluded from clash warnings entirely: a contract is a
   * standing arrangement — a school run, a daily office collection — and the
   * driver and the car are expected to do other work around it. Warning on
   * every one would put a permanent clash on the board that nobody can clear,
   * and a board of warnings nobody can clear is a board nobody reads.
   */
  isContract?: boolean | null;
}

export interface Interval {
  from: Date;
  to: Date;
}

/**
 * When a job ties the driver up.
 *
 * An as-directed hire's booked hours beat any estimate: the hours *are* the
 * job, and a four-hour hire recorded with a default sixty-minute estimate
 * would show as free from ten o'clock when it is not.
 */
export function occupiedBy(job: Occupies): Interval {
  const minutes =
    job.customerHours && job.customerHours > 0
      ? Math.round(job.customerHours * 60)
      : (job.estimatedMinutes ?? 0) > 0
        ? job.estimatedMinutes!
        : ASSUMED_MINUTES;

  return {
    from: job.scheduledAt,
    to: new Date(job.scheduledAt.getTime() + minutes * 60_000),
  };
}

/**
 * Whether two intervals collide once a buffer is allowed for travel.
 *
 * The buffer is applied once, to one side, rather than to both intervals —
 * padding both would double it, and a ninety-minute setting would refuse jobs
 * three hours apart.
 *
 * Touching is not overlapping: a job ending at 10:00 and one starting at
 * 10:00 with no buffer are back to back, which is tight but not impossible.
 */
export function overlaps(
  a: Interval,
  b: Interval,
  bufferMinutes = 0,
): boolean {
  const buffer = Math.max(0, bufferMinutes) * 60_000;
  return (
    a.from.getTime() - buffer < b.to.getTime() &&
    b.from.getTime() < a.to.getTime() + buffer
  );
}

export interface ConflictCandidate extends Occupies {
  reference: string;
  pickupText: string;
  dropoffText: string;
  status: string;
  driverId?: string | null;
  vehicleId?: string | null;
}

export interface Conflict {
  id: string;
  reference: string;
  scheduledAt: Date;
  pickupText: string;
  dropoffText: string;
  /** Minutes between the two, negative when they genuinely overlap. */
  gapMinutes: number;
  /** True when the jobs overlap outright rather than merely sitting close. */
  overlapping: boolean;
}

/**
 * Which of these jobs clash with the proposed one.
 *
 * Sorted by how bad the clash is — a genuine overlap first, then the tightest
 * gap. An operator looking at a warning wants the worst case at the top, not
 * the earliest.
 */
export function findConflicts(
  proposed: Occupies,
  against: ConflictCandidate[],
  bufferMinutes: number,
): Conflict[] {
  if (proposed.isContract) return [];

  const window = occupiedBy(proposed);

  return against
    .filter((candidate) => candidate.id !== proposed.id)
    // A contract day never raises a clash, on either side of the comparison.
    // See `Occupies.isContract`.
    .filter((candidate) => !candidate.isContract)
    .flatMap((candidate) => {
      const theirs = occupiedBy(candidate);
      if (!overlaps(window, theirs, bufferMinutes)) return [];

      // Negative when the two genuinely overlap, positive for the gap
      // between them once one has finished.
      const gapMs =
        theirs.from.getTime() >= window.to.getTime()
          ? theirs.from.getTime() - window.to.getTime()
          : window.from.getTime() >= theirs.to.getTime()
            ? window.from.getTime() - theirs.to.getTime()
            : -Math.min(
                window.to.getTime() - theirs.from.getTime(),
                theirs.to.getTime() - window.from.getTime(),
              );

      return [
        {
          id: candidate.id,
          reference: candidate.reference,
          scheduledAt: candidate.scheduledAt,
          pickupText: candidate.pickupText,
          dropoffText: candidate.dropoffText,
          gapMinutes: Math.round(gapMs / 60_000),
          overlapping: gapMs < 0,
        },
      ];
    })
    .sort((a, b) => a.gapMinutes - b.gapMinutes);
}

/**
 * The warning an operator reads.
 *
 * Names the job and says how bad it is, because "conflict detected" tells
 * somebody there is a problem without telling them whether it is a problem
 * they care about.
 */
export function describeConflict(
  conflict: Conflict,
  subject: 'driver' | 'vehicle',
): string {
  const who = subject === 'driver' ? 'This driver' : 'This vehicle';

  if (conflict.overlapping) {
    return `${who} is already on ${conflict.reference} at that time.`;
  }

  const hours = Math.floor(conflict.gapMinutes / 60);
  const minutes = conflict.gapMinutes % 60;
  const gap =
    hours > 0
      ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
      : `${conflict.gapMinutes} min`;

  return `${who} has ${conflict.reference} ${gap} away — tight, but possible.`;
}
