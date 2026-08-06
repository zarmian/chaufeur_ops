import { describe, expect, it } from 'vitest';
import { ZONES } from '../install';
import {
  extractOutwardCode,
  extractTerminal,
  normaliseText,
  resolveZone,
  zoneForPostcode,
  zoneForText,
  type ZoneRecord,
} from './zones';

/**
 * Zone matching decides what a booking is priced at, so the failures that
 * matter are the quiet ones: a Heathrow pickup landing in Greater London
 * because a shorter postcode prefix won, or "Kingsway" matching Kings Cross.
 * Both produce a confidently wrong price rather than an error.
 *
 * The zone list is the seeded one, so these tests are about the real
 * prefixes an install ships with rather than a convenient fixture.
 */

const zones: ZoneRecord[] = ZONES.map((zone, index) => ({
  id: `zone-${index}`,
  name: zone.name,
  postcodes: zone.postcodes,
}));

const byName = (name: string) => zones.find((zone) => zone.name === name)!;

describe('normaliseText', () => {
  it('flattens case, punctuation and spacing', () => {
    expect(normaliseText('  London  HEATHROW, Terminal-5! ')).toBe(
      'london heathrow terminal 5',
    );
  });

  it('is empty for text with nothing in it', () => {
    expect(normaliseText('  ---  ')).toBe('');
  });
});

describe('extractOutwardCode', () => {
  it('reads the outward code from a full postcode', () => {
    expect(extractOutwardCode('SW1A 1AA')).toBe('SW1A');
    expect(extractOutwardCode('The Dorchester, Park Lane, W1K 1QA')).toBe('W1K');
    expect(extractOutwardCode('tw6 1ep')).toBe('TW6');
  });

  it('reads a bare outward code standing alone', () => {
    expect(extractOutwardCode('TW6')).toBe('TW6');
    expect(extractOutwardCode('pickup in RH6 please')).toBe('RH6');
  });

  it('does not mistake part of an address for a postcode', () => {
    // "A1" in a road name would put the booking in a zone at random.
    expect(extractOutwardCode('The Dorchester, Park Lane')).toBeNull();
    expect(extractOutwardCode('Flat 3, 221B Baker Street')).toBeNull();
  });

  it('returns null rather than guessing', () => {
    expect(extractOutwardCode('')).toBeNull();
    expect(extractOutwardCode('somewhere in town')).toBeNull();
  });
});

describe('zoneForPostcode', () => {
  it('takes the longest matching prefix', () => {
    // TW6 is Heathrow and TW is Greater London. Shortest-match would put
    // every Heathrow pickup in the wrong zone, and price it wrong.
    expect(zoneForPostcode('TW6', zones)?.zoneName).toBe('Heathrow');
    expect(zoneForPostcode('TW9', zones)?.zoneName).toBe('Greater London');
  });

  it('does not let a short zone claim a longer postcode', () => {
    // Zone "E" is Greater London; E16 is London City. The more specific
    // prefix has to win.
    expect(zoneForPostcode('E16', zones)?.zoneName).toBe('London City');
    expect(zoneForPostcode('E14', zones)?.zoneName).toBe('Greater London');
  });

  it('matches the airports from their own prefixes', () => {
    expect(zoneForPostcode('RH6', zones)?.zoneName).toBe('Gatwick');
    expect(zoneForPostcode('LU2', zones)?.zoneName).toBe('Luton');
    expect(zoneForPostcode('CM24', zones)?.zoneName).toBe('Stansted');
  });

  it('reports what it matched on', () => {
    const match = zoneForPostcode('TW6', zones);
    expect(match?.by).toBe('postcode');
    expect(match?.matched).toBe('TW6');
  });

  it('returns null for a postcode in no zone', () => {
    // Outside the M25 has no prefixes, so a Manchester postcode matches
    // nothing rather than falling into Greater London.
    expect(zoneForPostcode('M1', zones)).toBeNull();
    expect(zoneForPostcode('', zones)).toBeNull();
  });
});

describe('zoneForText', () => {
  it('resolves every way people write Heathrow', () => {
    // Spec 4.1.4. These are the strings that actually come off a phone call.
    for (const text of [
      'London Heathrow airport terminal 5',
      'LHR T5',
      'Heathrow T5',
      'heathrow',
      'Terminal 3, London Heathrow Airport',
      'pickup from HEATHROW airport',
    ]) {
      expect(zoneForText(text, zones)?.zoneName, text).toBe('Heathrow');
    }
  });

  it('resolves the other airports', () => {
    expect(zoneForText('LGW north terminal', zones)?.zoneName).toBe('Gatwick');
    expect(zoneForText('London Luton Airport', zones)?.zoneName).toBe('Luton');
    expect(zoneForText('Stanstead airport', zones)?.zoneName).toBe('Stansted');
    expect(zoneForText('London City Airport', zones)?.zoneName).toBe(
      'London City',
    );
  });

  it('prefers the longer phrase when two could match', () => {
    // "London City Airport" contains "London City"; the airport is meant.
    const match = zoneForText('London City Airport', zones);
    expect(match?.zoneName).toBe('London City');
    expect(match?.matched).toBe('london city airport');
  });

  it('matches on word boundaries, not substrings', () => {
    // The failure this prevents: a street name quietly pricing as an airport.
    expect(zoneForText('Kingsway, Holborn', zones)?.zoneName).not.toBe(
      'Heathrow',
    );
    expect(zoneForText('Lutonia House', zones)).toBeNull();
    expect(zoneForText('Heathrowe Close', zones)).toBeNull();
  });

  it('returns null for an address it does not recognise', () => {
    // A miss is a first-class answer. Guessing produces a wrong price.
    expect(zoneForText('The Dorchester, Park Lane', zones)).toBeNull();
    expect(zoneForText('', zones)).toBeNull();
  });
});

describe('resolveZone', () => {
  it('trusts the postcode over the text', () => {
    // Somebody has made a mistake; the postcode is the half more likely to
    // be right.
    const match = resolveZone('Heathrow', zones, 'CR0 2RD');
    expect(match?.zoneName).toBe('Greater London');
    expect(match?.by).toBe('postcode');
  });

  it('falls back to the text when the postcode resolves to nothing', () => {
    const match = resolveZone('London Heathrow Terminal 5', zones, 'M1 1AA');
    expect(match?.zoneName).toBe('Heathrow');
    expect(match?.by).toBe('alias');
  });

  it('finds a postcode inside the pickup text when none is given', () => {
    const match = resolveZone('Sofitel, TW6 2GD', zones);
    expect(match?.zoneName).toBe('Heathrow');
    expect(match?.by).toBe('postcode');
  });

  it('returns null when neither signal resolves', () => {
    expect(resolveZone('The usual place', zones)).toBeNull();
  });
});

describe('extractTerminal', () => {
  it('reads the terminal people actually type', () => {
    expect(extractTerminal('Heathrow T5')).toBe('Terminal 5');
    expect(extractTerminal('London Heathrow airport terminal 5')).toBe(
      'Terminal 5',
    );
    expect(extractTerminal('LHR, Term 3')).toBe('Terminal 3');
  });

  it('is null when no terminal is named', () => {
    expect(extractTerminal('Heathrow')).toBeNull();
    expect(extractTerminal('The Dorchester')).toBeNull();
  });

  it('does not read a house number as a terminal', () => {
    expect(extractTerminal('5 Park Lane')).toBeNull();
  });
});

describe('the seeded zones', () => {
  it('covers every zone the spec names', () => {
    for (const name of [
      'Heathrow',
      'Gatwick',
      'Luton',
      'Stansted',
      'London City',
      'Central London',
      'Greater London',
      'Outside M25',
    ]) {
      expect(byName(name), name).toBeDefined();
    }
  });

  it('leaves Outside M25 with no prefixes, so it never wins by accident', () => {
    // It is where a booking lands when nothing else claims it, decided by
    // the caller — not something a postcode prefix should match into.
    expect(byName('Outside M25').postcodes).toEqual([]);
  });
});
