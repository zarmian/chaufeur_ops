/**
 * The physics behind every gesture in the interface.
 *
 * Pure, and deliberately free of imports, for two reasons. The obvious one is
 * that `lib/client-bundle.test.ts` walks the import graph out of every Client
 * Component, and everything here runs in the browser — the precedent is
 * `lib/enum-options.ts`. The less obvious one is that the maths below is the
 * part most likely to be wrong in a way nobody notices: a drag that lands a
 * little short feels "off" rather than broken, and nobody files a bug for it.
 * Kept pure, it can be tested against known values.
 *
 * The through-line, from `.claude/skills/apple-design/SKILL.md`: motion starts
 * from where the thing currently is, inherits the speed the hand gave it,
 * projects that speed forward to decide where it lands, and can be grabbed and
 * reversed at any moment. Springs do all four; a fixed-duration tween does
 * none of them.
 */

/**
 * Apple's two spring parameters, in the terms Motion actually takes.
 *
 * Apple replaced the physics triplet (mass, stiffness, damping) with damping
 * *ratio* and *response*, because those are the two a designer can hold in
 * their head. Motion's `bounce` and `duration` map onto them closely:
 *
 * - `bounce: 0` is damping ratio 1.0 — critically damped, settles without
 *   overshooting.
 * - `duration` is response: how quickly the value reaches the target. It is
 *   not a duration in the tween sense; a spring has no fixed end, and its
 *   settle time emerges from the parameters.
 *
 * **Bounce is not decoration and is not a default.** Overshoot is what a real
 * object does when something threw it, so it belongs only where a gesture
 * carried momentum — a flick, a drag release. On a menu that just faded in it
 * reads as the interface being pleased with itself.
 */
export interface Spring {
  type: 'spring';
  bounce: number;
  duration: number;
}

export const SPRING = {
  /** Repositioning something under its own steam. Apple ships 1.0 / 0.4. */
  default: { type: 'spring', bounce: 0, duration: 0.4 },
  /** Chrome: menus, popovers, indicators. Quick enough not to be waited on. */
  snappy: { type: 'spring', bounce: 0, duration: 0.3 },
  /** Drawers and sheets. Apple ships 0.8 / 0.3 — the bounce is the drag's. */
  sheet: { type: 'spring', bounce: 0.2, duration: 0.3 },
  /** Anything released from a gesture, where overshoot is earned. */
  momentum: { type: 'spring', bounce: 0.2, duration: 0.4 },
} as const satisfies Record<string, Spring>;

/**
 * Where a flick would come to rest.
 *
 * Scroll deceleration, in closed form: the total distance a value travels if
 * it starts at `velocity` and decays exponentially. Snap to the target nearest
 * the point this returns, rather than to the one nearest the release point —
 * that difference is what makes a flick feel like it *threw* the thing rather
 * than dropped it.
 *
 * This is the form in Apple's *Designing Fluid Interfaces* sample code. The
 * physics-textbook `v² / 2a` is a different curve and lands noticeably short;
 * it is not what iOS ships.
 *
 * @param velocity  Release velocity, in px per second. Sign is direction.
 * @param decelerationRate 0.998 is the normal scroll feel; 0.99 is snappier.
 * @returns Displacement in px, same sign as `velocity`.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  // Guarded because a rate of exactly 1 never decays — the projection is
  // infinite, and the NaN/Infinity it produces would be applied to a
  // transform and put the element somewhere unreachable.
  if (decelerationRate <= 0 || decelerationRate >= 1) return 0;
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * How far a thing follows the finger once it is past its limit.
 *
 * A hard stop at a boundary reads as frozen — the first thing anyone does is
 * let go and try again, because the interface stopped answering. Progressive
 * resistance says "still listening, but there is nothing more this way", which
 * is the truth.
 *
 * Asymptotic: as the overshoot grows the returned offset approaches
 * `dimension` and never reaches it, so no amount of dragging tears the element
 * off the screen. `constant` sets how fast it gets there — lower resists
 * harder and flattens sooner.
 *
 * @param overshoot How far past the boundary the pointer has gone, in px.
 * @param dimension The size of the container the resistance is relative to.
 * @param constant  0.55 is the iOS feel. Lower resists harder.
 */
export function rubberband(
  overshoot: number,
  dimension: number,
  constant = 0.55,
): number {
  if (dimension <= 0) return 0;
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}

/** One sampled pointer position, and when it was seen. */
export interface Sample {
  position: number;
  /** Milliseconds, from any monotonic clock — `event.timeStamp` will do. */
  time: number;
}

/**
 * The pointer's speed at release, in px per second.
 *
 * Measured over a short window rather than from the last two events. Two
 * consecutive `pointermove`s can be a millisecond and a pixel apart, which
 * divides out to a wild number, and handing that to a spring throws the
 * element off the screen. A window of about 100ms is long enough to be stable
 * and short enough to still describe the *end* of the gesture rather than its
 * average.
 *
 * Returns 0 when there is nothing to measure — a hold-then-release has no
 * velocity, and should settle rather than fly.
 *
 * @param samples Position history, oldest first.
 * @param windowMs How far back from the most recent sample to look.
 */
export function velocityFrom(samples: Sample[], windowMs = 100): number {
  if (samples.length < 2) return 0;

  const last = samples[samples.length - 1]!;

  // The oldest sample still inside the window. Walking back from the end
  // rather than filtering, so a long-held drag does not scan its whole
  // history on every release.
  let first = last;
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    const sample = samples[i]!;
    first = sample;
    if (last.time - sample.time >= windowMs) break;
  }

  const elapsed = last.time - first.time;
  if (elapsed <= 0) return 0;

  return ((last.position - first.position) / elapsed) * 1000;
}

/**
 * Keep a position history bounded.
 *
 * A drag across a dispatch board can fire hundreds of `pointermove` events;
 * only the last handful are ever read. Trimming as we go keeps the array from
 * growing without limit during a long drag.
 */
export function pushSample(
  samples: Sample[],
  sample: Sample,
  keep = 8,
): Sample[] {
  const next = samples.length >= keep ? samples.slice(1 - keep) : samples.slice();
  next.push(sample);
  return next;
}

/** A place something can be dropped, measured once at the start of a drag. */
export interface Zone {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Which zone the pointer is over, if any.
 *
 * Geometry rather than `document.elementFromPoint`, for a reason that only
 * shows up once the drag is running: the thing being dragged is under the
 * pointer, so `elementFromPoint` returns *it* rather than what is beneath it.
 * The usual fix is to set `pointer-events: none` on the dragged element,
 * which is a fiddly interaction with pointer capture and silently stops the
 * drag on some browsers if it is applied at the wrong moment.
 *
 * Measuring the targets once, when the drag commits, sidesteps all of it —
 * and is testable without a DOM, which `elementFromPoint` is not. It holds
 * because nothing reflows mid-drag: the board's poll is paused for exactly
 * this reason.
 *
 * Coordinates are viewport-relative, to match `getBoundingClientRect`. Later
 * zones win an overlap, matching the paint order of absolutely-positioned
 * siblings.
 */
export function zoneAt(zones: Zone[], x: number, y: number): string | null {
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const zone = zones[i]!;
    if (x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom) {
      return zone.id;
    }
  }
  return null;
}

/**
 * How fast to scroll while a drag is held near the edge of the screen.
 *
 * Without this a board taller than the window can only accept a drop on the
 * part of it you can already see. The first customer runs 195 owner-drivers,
 * so on any given day most of the rows are off screen — and the gesture that
 * fails is indistinguishable from one that was refused, because in both cases
 * nothing happens.
 *
 * Proportional rather than a fixed speed: barely into the zone creeps, right
 * at the edge moves at `max`. A single speed is either too slow to cross a
 * long board or too fast to stop on the row you wanted.
 *
 * @param pointer  Pointer position along the axis, in viewport coordinates.
 * @param size     The viewport's length along that axis.
 * @param zone     How deep the sensitive band at each end is, in px.
 * @param max      Top speed, px per second.
 * @returns px per second; negative scrolls towards the start, 0 means don't.
 */
export function edgeScrollVelocity(
  pointer: number,
  size: number,
  zone = 80,
  max = 1200,
): number {
  if (size <= 0 || zone <= 0) return 0;

  // Guard against a zone deeper than half the viewport, where the two bands
  // would overlap and fight each other in the middle of the screen.
  const band = Math.min(zone, size / 2);

  if (pointer < band) {
    // Clamped at the top: dragging above the window keeps scrolling rather
    // than accelerating without limit.
    const depth = Math.min(1, (band - pointer) / band);
    return -max * depth;
  }

  if (pointer > size - band) {
    const depth = Math.min(1, (pointer - (size - band)) / band);
    return max * depth;
  }

  return 0;
}

/**
 * The distance a pointer must travel before a drag is a drag.
 *
 * Without it every click on a draggable thing is a one-pixel drag, and the
 * click never lands. Ten pixels is Apple's figure and it survives a shaky
 * hand on a laptop trackpad.
 */
export const DRAG_THRESHOLD_PX = 10;

/**
 * Whether a gesture that started at `origin` has committed to being a drag.
 *
 * Distance rather than either axis alone: a diagonal 9px each way is 12.7px of
 * travel and is plainly a drag, but neither axis has passed the threshold.
 */
export function hasCommitted(
  origin: { x: number; y: number },
  current: { x: number; y: number },
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  return Math.hypot(dx, dy) >= threshold;
}
