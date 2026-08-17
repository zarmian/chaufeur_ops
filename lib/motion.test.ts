import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  hasCommitted,
  project,
  pushSample,
  rubberband,
  SPRING,
  velocityFrom,
  zoneAt,
  type Sample,
} from './motion';

/**
 * The gesture maths.
 *
 * These four functions decide where a dragged thing lands, how hard a
 * boundary pushes back, and how fast a release was. All of it is invisible
 * when right and merely "off" when wrong, so the values are pinned against
 * worked examples rather than left to be eyeballed in a browser.
 */

describe('spring presets', () => {
  it('defaults to critically damped', () => {
    // Overshoot is what a thrown object does. Everything that moves under its
    // own steam settles instead.
    expect(SPRING.default.bounce).toBe(0);
    expect(SPRING.snappy.bounce).toBe(0);
  });

  it('reserves bounce for momentum', () => {
    expect(SPRING.sheet.bounce).toBeGreaterThan(0);
    expect(SPRING.momentum.bounce).toBeGreaterThan(0);
  });

  it('keeps every response inside the range Apple ships', () => {
    // 0.3–0.4s. Slower than this and the interface is waited on; faster and
    // the motion is a cut rather than a movement.
    for (const [name, spring] of Object.entries(SPRING)) {
      expect(spring.duration, name).toBeGreaterThanOrEqual(0.3);
      expect(spring.duration, name).toBeLessThanOrEqual(0.4);
    }
  });
});

describe('momentum projection', () => {
  it('matches the worked example', () => {
    // 50px/s at the standard deceleration rate travels a further 24.95px.
    expect(project(50)).toBeCloseTo(24.95, 5);
  });

  it('scales linearly with velocity', () => {
    // Twice the flick, twice the distance — which is what makes a hard throw
    // feel proportionate rather than capped.
    expect(project(1000)).toBeCloseTo(2 * project(500), 5);
  });

  it('keeps the direction of the gesture', () => {
    expect(project(-400)).toBeCloseTo(-project(400), 5);
  });

  it('lands nearer with a snappier deceleration rate', () => {
    expect(project(500, 0.99)).toBeLessThan(project(500, 0.998));
  });

  it('is still at rest', () => {
    expect(project(0)).toBe(0);
  });

  it('refuses a rate that never decays rather than returning Infinity', () => {
    // The guard exists because the result goes straight into a transform. An
    // Infinity there puts the element somewhere the user cannot reach it, and
    // a NaN silently removes the transform altogether.
    expect(project(500, 1)).toBe(0);
    expect(project(500, 0)).toBe(0);
    expect(Number.isFinite(project(500, 1.5))).toBe(true);
  });
});

describe('rubber-banding', () => {
  it('matches the worked example', () => {
    // 100px past the edge of a 500px container buys 49.55px of movement.
    expect(rubberband(100, 500)).toBeCloseTo(49.55, 2);
  });

  it('follows the finger less the further past the edge it goes', () => {
    // The test of resistance: the second hundred pixels of overshoot must buy
    // less movement than the first.
    const first = rubberband(100, 500);
    const second = rubberband(200, 500) - first;
    expect(second).toBeLessThan(first);
  });

  it('never reaches the asymptote, however hard it is dragged', () => {
    // The limit is the container's own dimension. A drag of a million pixels
    // moves the element 499.5 of them and no further, so nothing can be
    // hauled off the screen and left there.
    expect(rubberband(1_000_000, 500)).toBeLessThan(500);
    expect(rubberband(1_000_000, 500)).toBeGreaterThan(499);
  });

  it('resists symmetrically in both directions', () => {
    expect(rubberband(-100, 500)).toBeCloseTo(-rubberband(100, 500), 6);
  });

  it('resists harder with a smaller constant', () => {
    expect(rubberband(100, 500, 0.2)).toBeLessThan(rubberband(100, 500, 0.55));
  });

  it('does not divide by a zero-sized container', () => {
    expect(rubberband(100, 0)).toBe(0);
  });
});

describe('release velocity', () => {
  const samples = (...pairs: [number, number][]): Sample[] =>
    pairs.map(([position, time]) => ({ position, time }));

  it('reads px per second from the position history', () => {
    expect(velocityFrom(samples([0, 0], [50, 100]))).toBeCloseTo(500, 6);
  });

  it('keeps the direction of travel', () => {
    expect(velocityFrom(samples([50, 0], [0, 100]))).toBeCloseTo(-500, 6);
  });

  it('measures the end of the gesture, not its average', () => {
    // Someone who dragged slowly, then flicked, released at flick speed. An
    // average over the whole drag would hand the spring a fraction of the
    // velocity the hand actually gave it.
    const slowThenFast = samples([0, 0], [10, 500], [20, 550], [120, 600]);
    expect(velocityFrom(slowThenFast)).toBeGreaterThan(1000);
  });

  it('treats a hold-then-release as still', () => {
    // The pointer stopped 300ms before letting go. It should settle where it
    // is, not fly off carrying velocity from earlier in the drag.
    const held = samples([0, 0], [100, 100], [100, 300], [100, 400]);
    expect(velocityFrom(held)).toBe(0);
  });

  it('has no velocity from a single sample', () => {
    expect(velocityFrom(samples([0, 0]))).toBe(0);
    expect(velocityFrom([])).toBe(0);
  });

  it('does not divide by zero when two events share a timestamp', () => {
    // Coalesced pointer events genuinely arrive with identical timeStamps.
    const simultaneous = samples([0, 100], [40, 100]);
    expect(velocityFrom(simultaneous)).toBe(0);
  });
});

describe('the sample buffer', () => {
  it('keeps only the most recent samples', () => {
    let history: Sample[] = [];
    for (let i = 0; i < 50; i += 1) {
      history = pushSample(history, { position: i, time: i * 10 }, 8);
    }
    expect(history).toHaveLength(8);
    expect(history[history.length - 1]!.position).toBe(49);
    expect(history[0]!.position).toBe(42);
  });

  it('does not mutate the array it was given', () => {
    const original: Sample[] = [{ position: 1, time: 1 }];
    pushSample(original, { position: 2, time: 2 });
    expect(original).toHaveLength(1);
  });
});

describe('drop zones', () => {
  const rows = [
    { id: 'driver-a', top: 100, bottom: 150, left: 200, right: 800 },
    { id: 'driver-b', top: 150, bottom: 200, left: 200, right: 800 },
  ];

  it('finds the row under the pointer', () => {
    expect(zoneAt(rows, 400, 120)).toBe('driver-a');
    expect(zoneAt(rows, 400, 175)).toBe('driver-b');
  });

  it('returns nothing outside every row', () => {
    expect(zoneAt(rows, 400, 40)).toBeNull();
    expect(zoneAt(rows, 400, 400)).toBeNull();
    // Left of the timeline, over the driver-name column.
    expect(zoneAt(rows, 100, 120)).toBeNull();
  });

  it('counts the edges as inside', () => {
    // A drop right on the boundary between two rows has to land somewhere,
    // and "nowhere" would silently do nothing after a completed gesture.
    expect(zoneAt(rows, 200, 100)).toBe('driver-a');
    expect(zoneAt(rows, 800, 150)).toBe('driver-b');
  });

  it('takes the last of two overlapping rows', () => {
    // Painted order: the one drawn on top is the one that would have been
    // clicked, so it is the one the drop belongs to.
    const overlapping = [
      { id: 'under', top: 0, bottom: 100, left: 0, right: 100 },
      { id: 'over', top: 50, bottom: 150, left: 0, right: 100 },
    ];
    expect(zoneAt(overlapping, 50, 75)).toBe('over');
  });

  it('finds nothing when there is nothing', () => {
    expect(zoneAt([], 10, 10)).toBeNull();
  });
});

describe('the drag threshold', () => {
  it('ignores the wobble in a click', () => {
    expect(hasCommitted({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(false);
  });

  it('commits once the pointer has really travelled', () => {
    expect(hasCommitted({ x: 0, y: 0 }, { x: 0, y: DRAG_THRESHOLD_PX })).toBe(true);
  });

  it('measures distance, not either axis alone', () => {
    // 9px each way is under the threshold on both axes and 12.7px of actual
    // travel. Checking the axes separately would call this a click.
    expect(hasCommitted({ x: 0, y: 0 }, { x: 9, y: 9 })).toBe(true);
  });

  it('commits in any direction', () => {
    expect(hasCommitted({ x: 100, y: 100 }, { x: 80, y: 100 })).toBe(true);
    expect(hasCommitted({ x: 100, y: 100 }, { x: 100, y: 80 })).toBe(true);
  });
});
