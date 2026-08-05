import { describe, expect, it } from 'vitest';
import {
  DRIVER_REFERENCE_PAD,
  DRIVER_REFERENCE_PREFIX,
  formatReference,
  JOB_REFERENCE_PAD,
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

describe('job references', () => {
  it('pads to six digits, so the series reads like the documented example', () => {
    expect(formatReference('JOB', 767, JOB_REFERENCE_PAD)).toBe('JOB-000767');
  });

  it('works with whatever prefix an install configures', () => {
    // The prefix is branding, not a constant. Nothing in the codebase names a
    // customer, so the format has to hold for any of them.
    for (const prefix of ['JOB', 'WLX', 'AC']) {
      const reference = formatReference(prefix, 42, JOB_REFERENCE_PAD);
      expect(reference).toBe(`${prefix}-000042`);
      expect(parseReference(reference, prefix)).toBe(42);
    }
  });

  it('does not confuse two series that share a leading substring', () => {
    // With a naive prefix match, `JOB` would swallow `JOBX-000001`.
    expect(parseReference('JOBX-000001', 'JOB')).toBeNull();
    expect(parseReference('JOB-000001', 'JOBX')).toBeNull();
  });
});

describe('prefix escaping', () => {
  it('treats a regex metacharacter in a configured prefix as a literal', () => {
    // The prefix comes from settings and reaches both a JS RegExp and a
    // POSIX pattern in SQL. Unescaped, `A.C` would match `ABC-000001`.
    expect(parseReference('ABC-000001', 'A.C')).toBeNull();
    expect(parseReference('A.C-000001', 'A.C')).toBe(1);
  });

  it('handles a prefix containing other pattern syntax', () => {
    for (const prefix of ['A+B', 'A(B)', 'A[B]', 'A$B', 'A|B']) {
      const reference = formatReference(prefix, 7, JOB_REFERENCE_PAD);
      expect(parseReference(reference, prefix), prefix).toBe(7);
    }
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
