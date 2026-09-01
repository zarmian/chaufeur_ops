import { describe, expect, it } from 'vitest';
import {
  blankFlightConfig,
  flightsUsable,
  normaliseFlightNumber,
} from './types';

/**
 * A flight number is typed by a person at speed into a free-text box.
 *
 * `BA 0117`, `ba117` and `BA117` are one aeroplane, and treating them as three
 * asks the provider three times and is billed for three. Worse, the cache
 * would miss every time and a flight already known to be delayed would look
 * like a flight nobody had checked.
 */
describe('normaliseFlightNumber', () => {
  it('accepts the shapes people actually type', () => {
    expect(normaliseFlightNumber('BA117')).toBe('BA117');
    expect(normaliseFlightNumber('ba 117')).toBe('BA117');
    expect(normaliseFlightNumber('  BA-117 ')).toBe('BA117');
    expect(normaliseFlightNumber('BA 0117')).toBe('BA117');
  });

  it('handles carriers whose code is not two letters', () => {
    // easyJet is U2, Germanwings was 4U, and ICAO codes are three letters.
    expect(normaliseFlightNumber('U2 8331')).toBe('U28331');
    expect(normaliseFlightNumber('4u 762')).toBe('4U762');
    expect(normaliseFlightNumber('EZY123')).toBe('EZY123');
  });

  it('does not let the three-letter carrier branch eat a leading zero', () => {
    /*
     * `[A-Z]{3}` tried first would read `BA0117` as carrier `BA0`, flight
     * `117`, and hand the provider a carrier that does not exist. The
     * two-character forms are matched first for exactly this, and the
     * leading zero is what makes the difference visible.
     */
    expect(normaliseFlightNumber('BA0117')).toBe('BA117');
    expect(normaliseFlightNumber('BA0117')).not.toBe('BA0117');
  });

  it('keeps a trailing letter, because some flights have one', () => {
    expect(normaliseFlightNumber('LH400A')).toBe('LH400A');
  });

  it('returns nothing for what is not a flight number', () => {
    // The pickup notes field gets used for all sorts of things.
    expect(normaliseFlightNumber('meeting at arrivals')).toBeNull();
    expect(normaliseFlightNumber('117')).toBeNull();
    expect(normaliseFlightNumber('BA')).toBeNull();
    expect(normaliseFlightNumber('')).toBeNull();
    expect(normaliseFlightNumber(null)).toBeNull();
  });
});

describe('flightsUsable', () => {
  it('is off until somebody has both switched it on and given it a key', () => {
    // Tracking is optional throughout: with nothing configured every airport
    // job behaves exactly as it did before any of this existed.
    const blank = blankFlightConfig();
    expect(flightsUsable(blank)).toBe(false);
    expect(flightsUsable({ ...blank, enabled: true })).toBe(false);
    expect(flightsUsable({ ...blank, apiKey: 'k' })).toBe(false);
    expect(flightsUsable({ ...blank, enabled: true, apiKey: 'k' })).toBe(true);
  });

  it('does not adjust bookings until somebody asks it to', () => {
    // Rewriting a booking automatically is right for most airport work and
    // wrong for the client whose driver was told nine o'clock whatever the
    // flight does. An install cannot know which it is until it has happened.
    expect(blankFlightConfig().autoAdjust).toBe(false);
  });
});
