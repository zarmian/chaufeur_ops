import type { JobEventType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  EVENT_LABELS,
  formatDuration,
  latestEvent,
  waitMinutesFromEvents,
  type JobEventRecord,
} from './job-events';

/**
 * The gap between ARRIVED and POB is billable revenue, so the arithmetic that
 * derives it is pinned here. Getting it wrong either loses the operator money
 * or overcharges a client.
 */

let counter = 0;
function event(type: JobEventType, iso: string): JobEventRecord {
  counter += 1;
  return {
    id: `evt_${counter}`,
    type,
    actorType: 'USER',
    actorId: 'usr_1',
    occurredAt: new Date(iso),
  };
}

describe('buildTimeline', () => {
  it('orders oldest first regardless of input order', () => {
    const timeline = buildTimeline([
      event('COMPLETED', '2026-08-04T12:00:00Z'),
      event('CREATED', '2026-08-04T09:00:00Z'),
      event('ASSIGNED', '2026-08-04T10:00:00Z'),
    ]);
    expect(timeline.map((e) => e.type)).toEqual([
      'CREATED',
      'ASSIGNED',
      'COMPLETED',
    ]);
  });

  it('leaves the first entry with no preceding gap', () => {
    const timeline = buildTimeline([event('CREATED', '2026-08-04T09:00:00Z')]);
    expect(timeline[0]?.minutesSincePrevious).toBeNull();
    expect(timeline[0]?.sincePrevious).toBeNull();
  });

  it('measures the gap between consecutive events', () => {
    const timeline = buildTimeline([
      event('ARRIVED', '2026-08-04T22:14:00Z'),
      event('POB', '2026-08-04T23:01:00Z'),
    ]);
    expect(timeline[1]?.minutesSincePrevious).toBe(47);
    expect(timeline[1]?.sincePrevious).toBe('47m');
  });

  it('labels every event type', () => {
    for (const type of Object.keys(EVENT_LABELS) as JobEventType[]) {
      expect(EVENT_LABELS[type], type).toBeTruthy();
    }
  });

  it('handles an empty log', () => {
    expect(buildTimeline([])).toEqual([]);
  });

  it('does not crash on two events sharing a timestamp', () => {
    // A status change written alongside an import can collide exactly.
    const timeline = buildTimeline([
      event('CREATED', '2026-08-04T09:00:00Z'),
      event('PRICE_SET', '2026-08-04T09:00:00Z'),
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.minutesSincePrevious).toBe(0);
    expect(timeline[1]?.sincePrevious).toBe('under a minute');
  });
});

describe('formatDuration', () => {
  it('renders minutes under an hour', () => {
    expect(formatDuration(45)).toBe('45m');
  });

  it('renders whole hours without a stray zero', () => {
    expect(formatDuration(120)).toBe('2h');
  });

  it('renders hours and minutes', () => {
    expect(formatDuration(75)).toBe('1h 15m');
  });

  it('describes a sub-minute gap in words rather than as 0m', () => {
    expect(formatDuration(0)).toBe('under a minute');
    expect(formatDuration(-5)).toBe('under a minute');
  });
});

describe('waitMinutesFromEvents', () => {
  it('measures ARRIVED to POB', () => {
    expect(
      waitMinutesFromEvents([
        event('ARRIVED', '2026-08-04T22:14:00Z'),
        event('POB', '2026-08-04T23:01:00Z'),
      ]),
    ).toBe(47);
  });

  it('returns null when the driver never marked arrival', () => {
    // Null is "not known". Zero would silently discard billable waiting time.
    expect(waitMinutesFromEvents([event('POB', '2026-08-04T23:01:00Z')])).toBeNull();
  });

  it('returns null when the passenger never boarded', () => {
    expect(
      waitMinutesFromEvents([event('ARRIVED', '2026-08-04T22:14:00Z')]),
    ).toBeNull();
  });

  it('returns null for a job with no events at all', () => {
    expect(waitMinutesFromEvents([])).toBeNull();
  });

  it('ignores a POB recorded before the arrival', () => {
    // Out-of-order events happen when a driver taps catch-up buttons; a
    // negative wait is never the right answer.
    expect(
      waitMinutesFromEvents([
        event('POB', '2026-08-04T22:00:00Z'),
        event('ARRIVED', '2026-08-04T22:14:00Z'),
      ]),
    ).toBeNull();
  });

  it('uses the first POB after arrival when a driver double-taps', () => {
    expect(
      waitMinutesFromEvents([
        event('ARRIVED', '2026-08-04T22:00:00Z'),
        event('POB', '2026-08-04T22:30:00Z'),
        event('POB', '2026-08-04T22:45:00Z'),
      ]),
    ).toBe(30);
  });

  it('uses the first arrival when a driver taps it twice', () => {
    expect(
      waitMinutesFromEvents([
        event('ARRIVED', '2026-08-04T22:00:00Z'),
        event('ARRIVED', '2026-08-04T22:05:00Z'),
        event('POB', '2026-08-04T22:30:00Z'),
      ]),
    ).toBe(30);
  });
});

describe('latestEvent', () => {
  it('finds the most recent event of a type', () => {
    const found = latestEvent(
      [
        event('ASSIGNED', '2026-08-04T09:00:00Z'),
        event('ASSIGNED', '2026-08-04T11:00:00Z'),
        event('CREATED', '2026-08-04T08:00:00Z'),
      ],
      'ASSIGNED',
    );
    expect(found?.occurredAt.toISOString()).toBe('2026-08-04T11:00:00.000Z');
  });

  it('returns null when the type never occurred', () => {
    expect(latestEvent([event('CREATED', '2026-08-04T08:00:00Z')], 'POB')).toBeNull();
  });
});
