import { describe, expect, it } from 'vitest';
import {
  ASSUMED_MINUTES,
  describeConflict,
  findConflicts,
  occupiedBy,
  overlaps,
  type ConflictCandidate,
} from './conflicts';

/**
 * Two jobs that cannot both happen.
 *
 * The case this exists to catch is the one a pickup-proximity check misses: a
 * four-hour as-directed hire starting at nine does not clash with a
 * nine-thirty pickup if you only compare pickup times, and the driver is
 * plainly in two places at once.
 */

function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 3, 7, hour, minute, 0));
}

function job(
  id: string,
  hour: number,
  overrides: Partial<ConflictCandidate> = {},
): ConflictCandidate {
  return {
    id,
    reference: `JOB-${id}`,
    scheduledAt: at(hour),
    pickupText: 'The Dorchester',
    dropoffText: 'Heathrow Terminal 5',
    status: 'ASSIGNED',
    ...overrides,
  };
}

describe('occupiedBy', () => {
  it('holds a driver for a contract\u2019s whole block', () => {
    // A five-day contract that fell through to an estimate would show the
    // driver as free from ten o'clock on the Monday, and the operator would
    // book them onto something on the Wednesday.
    const window = occupiedBy({
      id: 'a',
      scheduledAt: new Date('2026-07-27T09:00:00Z'),
      contractEndsAt: new Date('2026-07-31T22:59:59Z'),
      estimatedMinutes: 60,
    });
    expect(window.to.toISOString()).toBe('2026-07-31T22:59:59.000Z');
  });

  it('ignores a contract end that is not after the start', () => {
    // Bad data must not produce a backwards interval, which would overlap
    // nothing and silently disable the check.
    const window = occupiedBy({
      id: 'a',
      scheduledAt: new Date('2026-07-27T09:00:00Z'),
      contractEndsAt: new Date('2026-07-26T09:00:00Z'),
      estimatedMinutes: 90,
    });
    expect(window.to.getTime() - window.from.getTime()).toBe(90 * 60_000);
  });

  it('runs from the pickup for the estimated duration', () => {
    const window = occupiedBy({ id: 'a', scheduledAt: at(9), estimatedMinutes: 90 });
    expect(window.from).toEqual(at(9));
    expect(window.to).toEqual(at(10, 30));
  });

  it('assumes an hour when nothing was estimated', () => {
    const window = occupiedBy({ id: 'a', scheduledAt: at(9) });
    expect(window.to).toEqual(at(9 + ASSUMED_MINUTES / 60));
  });

  it('takes an as-directed hire’s booked hours over any estimate', () => {
    // The hours *are* the job. A four-hour hire carrying a default
    // sixty-minute estimate would otherwise read as free from ten o'clock.
    const window = occupiedBy({
      id: 'a',
      scheduledAt: at(9),
      estimatedMinutes: 60,
      customerHours: 4,
    });
    expect(window.to).toEqual(at(13));
  });
});

describe('overlaps', () => {
  const nine = { from: at(9), to: at(10) };

  it('is true when the intervals cross', () => {
    expect(overlaps(nine, { from: at(9, 30), to: at(11) })).toBe(true);
  });

  it('is false when they merely touch', () => {
    // Back to back is tight, not impossible, and the buffer is what says
    // whether it is workable.
    expect(overlaps(nine, { from: at(10), to: at(11) })).toBe(false);
  });

  it('brings a buffer into it', () => {
    expect(overlaps(nine, { from: at(10, 30), to: at(11) }, 0)).toBe(false);
    expect(overlaps(nine, { from: at(10, 30), to: at(11) }, 60)).toBe(true);
  });

  it('applies the buffer once, not to both sides', () => {
    // Padding both intervals would double it, and a ninety-minute setting
    // would then refuse jobs three hours apart.
    const later = { from: at(12), to: at(13) };
    expect(overlaps(nine, later, 90)).toBe(false);
    expect(overlaps(nine, later, 130)).toBe(true);
  });
});

describe('findConflicts', () => {
  it('finds a job the driver is plainly already on', () => {
    const conflicts = findConflicts(
      { id: 'new', scheduledAt: at(9, 30), estimatedMinutes: 60 },
      [job('a', 9, { customerHours: 4 })],
      0,
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.overlapping).toBe(true);
    expect(conflicts[0]?.reference).toBe('JOB-a');
  });

  it('leaves a comfortably separate job alone', () => {
    expect(
      findConflicts(
        { id: 'new', scheduledAt: at(15), estimatedMinutes: 60 },
        [job('a', 9, { estimatedMinutes: 60 })],
        60,
      ),
    ).toEqual([]);
  });

  it('flags a tight gap without calling it an overlap', () => {
    // 09:00–10:00 then 10:30. Not impossible; worth saying out loud.
    const conflicts = findConflicts(
      { id: 'new', scheduledAt: at(10, 30), estimatedMinutes: 60 },
      [job('a', 9, { estimatedMinutes: 60 })],
      60,
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.overlapping).toBe(false);
    expect(conflicts[0]?.gapMinutes).toBe(30);
  });

  it('never conflicts with itself', () => {
    // An edit re-checks the job being edited, and a job always overlaps
    // itself perfectly.
    expect(
      findConflicts(
        { id: 'a', scheduledAt: at(9), estimatedMinutes: 60 },
        [job('a', 9, { estimatedMinutes: 60 })],
        60,
      ),
    ).toEqual([]);
  });

  it('puts the worst clash first', () => {
    // An operator reading a warning wants the worst case at the top, not the
    // earliest one.
    const conflicts = findConflicts(
      { id: 'new', scheduledAt: at(10), estimatedMinutes: 60 },
      [
        job('near', 11, { estimatedMinutes: 60 }),
        job('overlapping', 10, { estimatedMinutes: 60 }),
      ],
      90,
    );

    expect(conflicts.map((c) => c.reference)).toEqual(['JOB-overlapping', 'JOB-near']);
    expect(conflicts[0]?.overlapping).toBe(true);
  });
});

describe('describeConflict', () => {
  it('says which job, because "conflict detected" tells nobody anything', () => {
    const overlapping = describeConflict(
      {
        id: 'a',
        reference: 'JOB-000123',
        scheduledAt: at(9),
        pickupText: 'x',
        dropoffText: 'y',
        gapMinutes: -30,
        overlapping: true,
      },
      'driver',
    );

    expect(overlapping).toContain('JOB-000123');
    expect(overlapping).toContain('already on');
  });

  it('reads the gap in hours once it is over one', () => {
    const message = describeConflict(
      {
        id: 'a',
        reference: 'JOB-000123',
        scheduledAt: at(9),
        pickupText: 'x',
        dropoffText: 'y',
        gapMinutes: 95,
        overlapping: false,
      },
      'vehicle',
    );

    expect(message).toContain('1h 35m');
    expect(message).toContain('This vehicle');
  });
});
