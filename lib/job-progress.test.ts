import { describe, expect, it } from 'vitest';
import {
  describeProgress,
  describeWaiting,
  MILESTONE_LABELS,
  MILESTONES,
  progressOf,
  type ProgressEvent,
} from './job-progress';

/**
 * Where a job has got to.
 *
 * The reduction is three lines and the reason it exists is one case: a driver
 * who taps a milestone out of order. Getting that wrong sends a dispatcher to
 * chase a job that is already halfway to the airport, so it is the case with
 * the most tests.
 */

const at = (iso: string): Date => new Date(iso);

const events = (...pairs: [string, string][]): ProgressEvent[] =>
  pairs.map(([type, iso]) => ({
    type: type as ProgressEvent['type'],
    occurredAt: at(iso),
  }));

const NOW = at('2026-08-21T12:00:00Z');

describe('progress along the path', () => {
  it('has nowhere to be with no events', () => {
    expect(progressOf([], NOW)).toEqual({
      milestone: null,
      at: null,
      fraction: 0,
      minutesSince: null,
    });
  });

  it('reports the furthest milestone reached', () => {
    const result = progressOf(
      events(
        ['ASSIGNED', '2026-08-21T09:00:00Z'],
        ['ACCEPTED', '2026-08-21T09:05:00Z'],
        ['ON_WAY', '2026-08-21T11:30:00Z'],
      ),
      NOW,
    );
    expect(result.milestone).toBe('ON_WAY');
    expect(result.minutesSince).toBe(30);
  });

  it('ignores bookkeeping events', () => {
    // A price set at noon is not progress, and taking the latest event would
    // make it look like the job had gone backwards.
    const result = progressOf(
      events(
        ['ASSIGNED', '2026-08-21T09:00:00Z'],
        ['POB', '2026-08-21T11:00:00Z'],
        ['EDITED', '2026-08-21T11:50:00Z'],
        ['PRICE_SET', '2026-08-21T11:55:00Z'],
      ),
      NOW,
    );
    expect(result.milestone).toBe('POB');
  });

  it('does not go backwards when a driver re-taps an earlier step', () => {
    // The case this function exists for. A mis-tap must not put a job that is
    // halfway to Heathrow back at the kerb — the board would send somebody to
    // chase a driver who is doing exactly what they should be.
    const result = progressOf(
      events(
        ['ON_WAY', '2026-08-21T10:00:00Z'],
        ['ARRIVED', '2026-08-21T10:30:00Z'],
        ['POB', '2026-08-21T10:45:00Z'],
        ['ARRIVED', '2026-08-21T11:00:00Z'],
      ),
      NOW,
    );
    expect(result.milestone).toBe('POB');
  });

  it('takes the most recent time a milestone was reached', () => {
    const result = progressOf(
      events(
        ['ARRIVED', '2026-08-21T10:00:00Z'],
        ['ARRIVED', '2026-08-21T11:00:00Z'],
      ),
      NOW,
    );
    expect(result.at?.toISOString()).toBe('2026-08-21T11:00:00.000Z');
    expect(result.minutesSince).toBe(60);
  });

  it('does not care what order the events arrive in', () => {
    const forwards = progressOf(
      events(['ASSIGNED', '2026-08-21T09:00:00Z'], ['POB', '2026-08-21T11:00:00Z']),
      NOW,
    );
    const backwards = progressOf(
      events(['POB', '2026-08-21T11:00:00Z'], ['ASSIGNED', '2026-08-21T09:00:00Z']),
      NOW,
    );
    expect(backwards).toEqual(forwards);
  });

  it('fills the stepper as the job proceeds', () => {
    const first = progressOf(events(['ASSIGNED', '2026-08-21T09:00:00Z']), NOW);
    const last = progressOf(events(['COMPLETED', '2026-08-21T09:00:00Z']), NOW);
    expect(first.fraction).toBeCloseTo(1 / MILESTONES.length, 6);
    expect(last.fraction).toBe(1);
  });

  it('never reports a negative age for an event stamped in the future', () => {
    // Clock skew between a driver's phone and the server is real, and a
    // negative "waiting" figure on the board reads as a rendering fault.
    const result = progressOf(events(['ARRIVED', '2026-08-21T12:30:00Z']), NOW);
    expect(result.minutesSince).toBe(0);
  });
});

describe('describing progress', () => {
  it('uses the present tense, not the log entry', () => {
    // "Arrived at pickup" is something that happened; "At pickup" is where
    // the driver is. A board wants the second.
    expect(MILESTONE_LABELS.ARRIVED).toBe('At pickup');
  });

  it('falls back to the status when a job has no events', () => {
    // Imported jobs carry no event history, and saying "not started" about a
    // job that finished last March is worse than saying nothing.
    const none = progressOf([], NOW);
    expect(describeProgress(none, 'COMPLETED')).toBe('Done');
    expect(describeProgress(none, 'CANCELLED')).toBe('Cancelled');
    expect(describeProgress(none, 'NO_SHOW')).toBe('No show');
    expect(describeProgress(none, 'PENDING')).toBe('Not started');
  });

  it('prefers the events over the status when it has both', () => {
    const onWay = progressOf(events(['ON_WAY', '2026-08-21T11:00:00Z']), NOW);
    expect(describeProgress(onWay, 'ASSIGNED')).toBe('On the way');
  });
});

describe('how long it has been', () => {
  it('says nothing about the first few minutes', () => {
    // Every job that has just arrived would otherwise fly a number, and the
    // ones worth acting on would be lost among them.
    expect(describeWaiting(0)).toBeNull();
    expect(describeWaiting(4)).toBeNull();
    expect(describeWaiting(null)).toBeNull();
  });

  it('counts minutes, then hours', () => {
    expect(describeWaiting(5)).toBe('5m');
    expect(describeWaiting(59)).toBe('59m');
    expect(describeWaiting(60)).toBe('1h');
    expect(describeWaiting(95)).toBe('1h 35m');
    expect(describeWaiting(120)).toBe('2h');
  });
});
