import { describe, expect, it } from 'vitest';
import { calculateWait, waitTimestamps } from './wait-time';

/**
 * Wait time — spec 5.5.7.
 *
 * Revenue the legacy system never billed, because nobody stood at the kerb
 * with a stopwatch. What matters most here is the refusal: a driver who
 * forgot to tap Arrived has not waited zero minutes, and writing a zero would
 * bill nothing for a two-hour wait and give nobody a reason to look.
 */

const AIRPORT = {
  jobType: 'AIRPORT_TRANSFER',
  freeWaitMinutes: 45,
  waitPerMinutePence: 50,
};

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 3, 7, 14, minutes, 0));
}

describe('calculateWait', () => {
  it('charges only the minutes past the allowance', () => {
    // 70 minutes waited, 45 free, 25 billable at 50p.
    const result = calculateWait({ ...AIRPORT, arrivedAt: at(0), pobAt: at(70) });

    expect(result.waitedMinutes).toBe(70);
    expect(result.billableMinutes).toBe(25);
    expect(result.pence).toBe(1250);
    expect(result.calculable).toBe(true);
  });

  it('charges nothing for a wait inside the allowance', () => {
    const result = calculateWait({ ...AIRPORT, arrivedAt: at(0), pobAt: at(30) });

    expect(result.waitedMinutes).toBe(30);
    expect(result.billableMinutes).toBe(0);
    expect(result.pence).toBe(0);
    // Still calculable: nothing to charge is an answer, unlike no answer.
    expect(result.calculable).toBe(true);
    expect(result.explanation).toContain('nothing to charge');
  });

  it('charges nothing for no wait at all', () => {
    const result = calculateWait({ ...AIRPORT, arrivedAt: at(0), pobAt: at(0) });
    expect(result.waitedMinutes).toBe(0);
    expect(result.pence).toBe(0);
  });

  it('refuses rather than assuming zero when Arrived is missing', () => {
    // The whole point. A missing tap is an unknown wait, not a zero one.
    const result = calculateWait({ ...AIRPORT, arrivedAt: null, pobAt: at(70) });

    expect(result.calculable).toBe(false);
    expect(result.waitedMinutes).toBeNull();
    expect(result.pence).toBe(0);
    expect(result.explanation).toContain('No Arrived tap');
  });

  it('waits for the passenger to be on board before deciding', () => {
    const result = calculateWait({ ...AIRPORT, arrivedAt: at(0), pobAt: null });
    expect(result.calculable).toBe(false);
    expect(result.explanation).toContain('Passenger on board');
  });

  it('refuses an inverted pair rather than billing a negative', () => {
    // Corrected timestamps, or ops repairing an out-of-order tap.
    const result = calculateWait({ ...AIRPORT, arrivedAt: at(70), pobAt: at(10) });
    expect(result.calculable).toBe(false);
    expect(result.pence).toBe(0);
    expect(result.explanation).toContain('check the timeline');
  });

  it('floors part minutes, because a minute nobody waited gets remembered', () => {
    const result = calculateWait({
      ...AIRPORT,
      arrivedAt: new Date('2026-04-07T14:00:00Z'),
      pobAt: new Date('2026-04-07T15:10:59Z'),
    });
    expect(result.waitedMinutes).toBe(70);
    expect(result.billableMinutes).toBe(25);
  });

  it('falls back to the job type’s allowance when no rule matched', () => {
    // 45 for an airport arrival, 15 for anything else — the documented
    // defaults, and the reason they differ is immigration and baggage.
    const airport = calculateWait({
      jobType: 'AIRPORT_TRANSFER',
      freeWaitMinutes: null,
      waitPerMinutePence: 50,
      arrivedAt: at(0),
      pobAt: at(50),
    });
    expect(airport.freeMinutes).toBe(45);
    expect(airport.billableMinutes).toBe(5);

    const transfer = calculateWait({
      jobType: 'TRANSFER',
      freeWaitMinutes: null,
      waitPerMinutePence: 50,
      arrivedAt: at(0),
      pobAt: at(50),
    });
    expect(transfer.freeMinutes).toBe(15);
    expect(transfer.billableMinutes).toBe(35);
  });

  it('says so when the rate card charges nothing per minute', () => {
    // A real state on a fresh install: the rules exist but the rates are
    // zero. Silently producing £0 would look like a short wait.
    const result = calculateWait({
      ...AIRPORT,
      waitPerMinutePence: 0,
      arrivedAt: at(0),
      pobAt: at(70),
    });
    expect(result.billableMinutes).toBe(25);
    expect(result.pence).toBe(0);
    expect(result.explanation).toContain('charges nothing per minute');
  });
});

describe('waitTimestamps', () => {
  it('picks the events out of a mixed timeline', () => {
    const { arrivedAt, pobAt } = waitTimestamps([
      { type: 'CREATED', occurredAt: at(0) },
      { type: 'ON_WAY', occurredAt: at(5) },
      { type: 'ARRIVED', occurredAt: at(20) },
      { type: 'POB', occurredAt: at(75) },
      { type: 'COMPLETED', occurredAt: at(110) },
    ]);

    expect(arrivedAt).toEqual(at(20));
    expect(pobAt).toEqual(at(75));
  });

  it('takes the first of a repeated tap, not the last', () => {
    // A driver who taps Arrived twice arrived once, and taking the later tap
    // would shorten a wait they really had.
    const { arrivedAt } = waitTimestamps([
      { type: 'ARRIVED', occurredAt: at(20) },
      { type: 'ARRIVED', occurredAt: at(26) },
    ]);
    expect(arrivedAt).toEqual(at(20));
  });

  it('is null for what never happened', () => {
    const { arrivedAt, pobAt } = waitTimestamps([
      { type: 'CREATED', occurredAt: at(0) },
    ]);
    expect(arrivedAt).toBeNull();
    expect(pobAt).toBeNull();
  });
});
