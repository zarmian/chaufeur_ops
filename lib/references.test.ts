import { describe, expect, it } from 'vitest';
import {
  DRIVER_REFERENCE_PAD,
  DRIVER_REFERENCE_PREFIX,
  formatReference,
  parseReference,
} from './references';

describe('formatReference', () => {
  it('zero-pads to a fixed width', () => {
    expect(formatReference('DRV', 1, 4)).toBe('DRV-0001');
    expect(formatReference('DRV', 147, 4)).toBe('DRV-0147');
  });

  it('does not truncate once the series outgrows the padding', () => {
    // Better a wider reference than a duplicate one.
    expect(formatReference('DRV', 12345, 4)).toBe('DRV-12345');
  });

  it('uses the documented driver format', () => {
    expect(
      formatReference(DRIVER_REFERENCE_PREFIX, 147, DRIVER_REFERENCE_PAD),
    ).toBe('DRV-0147');
  });
});

describe('parseReference', () => {
  it('round-trips with formatReference', () => {
    for (const sequence of [1, 9, 10, 99, 100, 1000, 99999]) {
      const reference = formatReference('DRV', sequence, 4);
      expect(parseReference(reference, 'DRV')).toBe(sequence);
    }
  });

  it('ignores a reference from another series', () => {
    expect(parseReference('WLX-000767', 'DRV')).toBeNull();
  });

  it('ignores anything malformed', () => {
    expect(parseReference('DRV-', 'DRV')).toBeNull();
    expect(parseReference('DRV0001', 'DRV')).toBeNull();
    expect(parseReference('DRV-abc', 'DRV')).toBeNull();
    expect(parseReference('', 'DRV')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseReference('  DRV-0042  ', 'DRV')).toBe(42);
  });
});

describe('reference ordering', () => {
  it('sorts numerically once parsed, which lexical order would not', () => {
    // DRV-0009 sorts above DRV-0010 as text, which is why the next-number
    // query extracts the integer in SQL rather than taking the last row.
    const references = ['DRV-0009', 'DRV-0010', 'DRV-0002'];
    expect([...references].sort()).toEqual([
      'DRV-0002',
      'DRV-0009',
      'DRV-0010',
    ]);

    const parsed = references
      .map((r) => parseReference(r, 'DRV') ?? 0)
      .sort((a, b) => a - b);
    expect(parsed).toEqual([2, 9, 10]);
    expect(Math.max(...parsed)).toBe(10);
  });
});
