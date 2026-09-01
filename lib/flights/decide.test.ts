import { describe, expect, it } from 'vitest';
import {
  decideFlightAdjustment,
  describeMinutes,
  shouldRefresh,
} from './decide';
import type { FlightReport, FlightState } from './types';

/**
 * The rules dispatch will argue about, settled here.
 *
 * Every case below is one somebody has to live with at six in the morning:
 * a flight ninety minutes late, a flight that landed early while the driver
 * was already on the M4, a cancellation, a flight number typed wrong. The
 * decision is pure so all of them can be stated as data rather than
 * discovered in production.
 */

const SCHEDULED_ARRIVAL = new Date('2026-09-15T06:00:00Z');
/** Somebody booked the car for 40 minutes after landing. That is the buffer. */
const PICKUP = new Date('2026-09-15T06:40:00Z');
const NOW = new Date('2026-09-15T02:00:00Z');

function report(over: Partial<FlightReport> = {}): FlightReport {
  return {
    flightNumber: 'BA117',
    state: 'SCHEDULED' as FlightState,
    scheduledArrival: SCHEDULED_ARRIVAL,
    estimatedArrival: null,
    actualArrival: null,
    origin: 'JFK',
    destination: 'LHR',
    terminal: '5',
    ...over,
  };
}

function decide(
  over: Partial<Parameters<typeof decideFlightAdjustment>[0]> = {},
) {
  return decideFlightAdjustment({
    pickupAt: PICKUP,
    flight: report(),
    now: NOW,
    minShiftMinutes: 15,
    minNoticeMinutes: 90,
    ...over,
  });
}

describe('decideFlightAdjustment', () => {
  it('does nothing while the flight is running to time', () => {
    expect(decide().action).toBe('HOLD');
  });

  it('keeps the operator’s buffer rather than imposing one of its own', () => {
    /*
     * The rule the whole module turns on. 40 minutes after landing is
     * somebody's judgement about that terminal and that client; a flight 90
     * minutes late moves the pickup 90 minutes, and the pickup stays 40
     * minutes after the aeroplane.
     */
    const decision = decide({
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T07:30:00Z'),
      }),
    });

    expect(decision.action).toBe('SHIFT');
    expect(decision.shiftMinutes).toBe(90);
    expect(decision.pickupAt?.toISOString()).toBe('2026-09-15T08:10:00.000Z');

    const gap =
      decision.pickupAt!.getTime() - new Date('2026-09-15T07:30:00Z').getTime();
    expect(gap).toBe(40 * 60_000);
  });

  it('measures the buffer from where a person put the pickup, not from its own last move', () => {
    /*
     * Without this the adjustments compound: a flight delayed an hour, then
     * another hour, would move the pickup an hour and then two, walking the
     * car steadily away from the aeroplane it is meeting.
     */
    const decision = decide({
      // An earlier run already moved it an hour for the first delay.
      pickupAt: new Date('2026-09-15T07:40:00Z'),
      basePickupAt: PICKUP,
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T08:00:00Z'),
      }),
    });

    // 08:00 + the original 40-minute buffer, not + 100 minutes.
    expect(decision.pickupAt?.toISOString()).toBe('2026-09-15T08:40:00.000Z');
    expect(decision.shiftMinutes).toBe(60);
  });

  it('prefers the actual landing over any estimate', () => {
    const decision = decide({
      flight: report({
        state: 'LANDED',
        estimatedArrival: new Date('2026-09-15T07:30:00Z'),
        actualArrival: new Date('2026-09-15T07:05:00Z'),
      }),
    });

    expect(decision.pickupAt?.toISOString()).toBe('2026-09-15T07:45:00.000Z');
  });

  it('ignores a movement too small to re-plan for', () => {
    const decision = decide({
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T06:12:00Z'),
      }),
    });

    expect(decision.action).toBe('HOLD');
    expect(decision.shiftMinutes).toBe(12);
  });

  it('acts once the movement crosses the threshold', () => {
    const decision = decide({
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T06:15:00Z'),
      }),
    });

    expect(decision.action).toBe('SHIFT');
    expect(decision.shiftMinutes).toBe(15);
  });

  it('never moves a pickup for a cancelled flight', () => {
    // A cancellation is not a delay. Rewriting the booking would hide it.
    const decision = decide({ flight: report({ state: 'CANCELLED' }) });

    expect(decision.action).toBe('FLAG');
    expect(decision.flag).toBe('CANCELLED');
    expect(decision.pickupAt).toBeNull();
    expect(decision.explanation).toContain('cancelled');
  });

  it('never moves a pickup for a diverted flight', () => {
    // The time is not the problem; the airport is.
    const decision = decide({
      flight: report({
        state: 'DIVERTED',
        estimatedArrival: new Date('2026-09-15T09:00:00Z'),
      }),
    });

    expect(decision.action).toBe('FLAG');
    expect(decision.flag).toBe('DIVERTED');
    expect(decision.pickupAt).toBeNull();
  });

  it('flags rather than guesses when there is no timetable to measure against', () => {
    // Almost always a mistyped flight number, which somebody can fix.
    const decision = decide({
      flight: report({ scheduledArrival: null, state: 'UNKNOWN' }),
    });

    expect(decision.action).toBe('FLAG');
    expect(decision.flag).toBe('NO_BASELINE');
    expect(decision.explanation).toContain('Check the flight number');
  });

  it('pulls a pickup forward when an early landing leaves enough notice', () => {
    const decision = decide({
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T05:00:00Z'),
      }),
    });

    expect(decision.action).toBe('SHIFT');
    expect(decision.shiftMinutes).toBe(-60);
    expect(decision.pickupAt?.toISOString()).toBe('2026-09-15T05:40:00.000Z');
  });

  it('refuses to pull a pickup forward at short notice', () => {
    /*
     * The dangerous half of good news. Moving a pickup earlier when the
     * driver may already be on the road makes them late for a time they were
     * never given; a person can ring them, and this cannot.
     */
    const decision = decide({
      now: new Date('2026-09-15T05:00:00Z'),
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T04:45:00Z'),
      }),
    });

    expect(decision.action).toBe('FLAG');
    expect(decision.flag).toBe('EARLY');
    // The time it *would* be is still reported, so an operator can apply it.
    expect(decision.pickupAt?.toISOString()).toBe('2026-09-15T05:25:00.000Z');
    expect(decision.explanation).toContain('too close');
  });

  it('still moves a late pickup at short notice', () => {
    // Later is always safe: nobody misses a car by being told it is later.
    const decision = decide({
      now: new Date('2026-09-15T06:30:00Z'),
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T07:00:00Z'),
      }),
    });

    expect(decision.action).toBe('SHIFT');
    expect(decision.shiftMinutes).toBe(60);
  });

  it('explains itself in a line somebody can read aloud', () => {
    const decision = decide({
      flight: report({
        state: 'ACTIVE',
        estimatedArrival: new Date('2026-09-15T07:35:00Z'),
      }),
    });

    expect(decision.explanation).toBe(
      'BA117 is 1 hour 35 minutes late. Pickup moves back 1 hour 35 minutes.',
    );
  });
});

describe('describeMinutes', () => {
  it('reads as a person would say it', () => {
    expect(describeMinutes(1)).toBe('1 minute');
    expect(describeMinutes(45)).toBe('45 minutes');
    expect(describeMinutes(60)).toBe('1 hour');
    expect(describeMinutes(95)).toBe('1 hour 35 minutes');
    expect(describeMinutes(120)).toBe('2 hours');
    expect(describeMinutes(-90)).toBe('1 hour 30 minutes');
  });
});

describe('shouldRefresh', () => {
  const now = new Date('2026-09-15T02:00:00Z');

  it('asks about a flight nothing has asked about', () => {
    expect(
      shouldRefresh({
        checkedAt: null,
        scheduledArrival: SCHEDULED_ARRIVAL,
        now,
        refreshMinutes: 20,
      }),
    ).toBe(true);
  });

  it('leaves a recently checked flight alone', () => {
    expect(
      shouldRefresh({
        checkedAt: new Date('2026-09-15T01:55:00Z'),
        scheduledArrival: SCHEDULED_ARRIVAL,
        now,
        refreshMinutes: 20,
      }),
    ).toBe(false);
  });

  it('asks again once the interval has passed', () => {
    expect(
      shouldRefresh({
        checkedAt: new Date('2026-09-15T01:30:00Z'),
        scheduledArrival: SCHEDULED_ARRIVAL,
        now,
        refreshMinutes: 20,
      }),
    ).toBe(true);
  });

  it('looks more often in the hour around landing', () => {
    /*
     * Where an estimate moves twenty minutes between one look and the next,
     * and where a stale answer is the one that puts a driver in the wrong
     * place. Every other hour of the flight can wait.
     */
    const closeIn = new Date('2026-09-15T05:30:00Z');
    expect(
      shouldRefresh({
        checkedAt: new Date('2026-09-15T05:24:00Z'),
        scheduledArrival: SCHEDULED_ARRIVAL,
        now: closeIn,
        refreshMinutes: 20,
      }),
    ).toBe(true);

    // Still not every single run — one look a minute would bill for nothing.
    expect(
      shouldRefresh({
        checkedAt: new Date('2026-09-15T05:28:00Z'),
        scheduledArrival: SCHEDULED_ARRIVAL,
        now: closeIn,
        refreshMinutes: 20,
      }),
    ).toBe(false);
  });
});
