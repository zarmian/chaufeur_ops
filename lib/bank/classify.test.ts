import { describe, expect, it } from 'vitest';
import {
  classify,
  directionAllows,
  matchPayer,
  normaliseDescription,
  stripForMatching,
  wouldAlsoMatch,
  type ClassifyRule,
} from './classify';

/**
 * Deciding what a statement line is.
 *
 * The rule that matters most is the one about restraint: anything unmatched
 * stays `UNCLASSIFIED`. A wrong classification nobody notices is worse than
 * an obvious gap somebody fixes, because the first quietly moves money and
 * the second only looks untidy.
 */

function rule(overrides: Partial<ClassifyRule> & { phrase: string }): ClassifyRule {
  return {
    id: `r-${overrides.phrase}`,
    kind: 'FUEL',
    priority: 0,
    active: true,
    ...overrides,
  };
}

describe('normaliseDescription', () => {
  it('collapses the shouting and the runs of spaces banks emit', () => {
    expect(normaliseDescription('SHELL   FILLING STN  4412')).toBe(
      'shell filling stn 4412',
    );
  });
});

describe('classify', () => {
  it('matches a phrase inside a noisy description', () => {
    const result = classify(
      { description: 'SHELL   FILLING STN  4412', amountPence: -8950 },
      [rule({ phrase: 'shell', kind: 'FUEL' })],
    );

    expect(result.kind).toBe('FUEL');
    expect(result.why).toContain('shell');
  });

  it('leaves anything unmatched unclassified rather than guessing', () => {
    const result = classify(
      { description: 'SOME PAYMENT REF 99', amountPence: 12_500 },
      [rule({ phrase: 'shell' })],
    );

    expect(result.kind).toBe('UNCLASSIFIED');
    expect(result.ruleId).toBeNull();
    expect(result.why).toContain('No rule matched');
  });

  it('prefers the longer, more specific phrase', () => {
    const result = classify(
      { description: 'SHELL RECHARGE POINT 12', amountPence: -1200 },
      [
        rule({ phrase: 'shell', kind: 'FUEL' }),
        rule({ phrase: 'shell recharge', kind: 'VEHICLE_COST' }),
      ],
    );

    expect(result.kind).toBe('VEHICLE_COST');
  });

  it('breaks a same-length tie on priority', () => {
    const result = classify(
      { description: 'ACME LTD', amountPence: 12_500 },
      [
        rule({ id: 'a', phrase: 'acme', kind: 'CLIENT_PAYMENT', priority: 0 }),
        rule({ id: 'b', phrase: 'acme', kind: 'RENTAL_INCOME', priority: 5 }),
      ],
    );

    expect(result.kind).toBe('RENTAL_INCOME');
  });

  it('refuses a rule that contradicts the direction of the money', () => {
    // A rule saying CLIENT_PAYMENT cannot apply to money leaving the
    // account, however well its phrase matched.
    const result = classify(
      { description: 'HALDEN AND CO', amountPence: -50_000 },
      [rule({ phrase: 'halden', kind: 'CLIENT_PAYMENT' })],
    );

    expect(result.kind).toBe('UNCLASSIFIED');
  });

  it('carries the counterparty a rule pins', () => {
    const result = classify(
      { description: 'HALDEN AND CO LTD', amountPence: 125_000 },
      [
        rule({
          phrase: 'halden',
          kind: 'CLIENT_PAYMENT',
          clientId: 'client-1',
        }),
      ],
    );

    expect(result.clientId).toBe('client-1');
  });

  it('ignores an inactive rule', () => {
    const result = classify({ description: 'SHELL', amountPence: -100 }, [
      rule({ phrase: 'shell', active: false }),
    ]);
    expect(result.kind).toBe('UNCLASSIFIED');
  });

  it('ignores a blank phrase, which would match everything', () => {
    const result = classify({ description: 'ANYTHING', amountPence: -100 }, [
      rule({ phrase: '   ' }),
    ]);
    expect(result.kind).toBe('UNCLASSIFIED');
  });
});

describe('directionAllows', () => {
  it('keeps income and cost on their own sides', () => {
    expect(directionAllows('CLIENT_PAYMENT', true)).toBe(true);
    expect(directionAllows('CLIENT_PAYMENT', false)).toBe(false);
    expect(directionAllows('FUEL', false)).toBe(true);
    expect(directionAllows('FUEL', true)).toBe(false);
  });

  it('lets a transfer go either way', () => {
    expect(directionAllows('TRANSFER', true)).toBe(true);
    expect(directionAllows('TRANSFER', false)).toBe(true);
  });
});

describe('matchPayer', () => {
  const payers = [
    { id: 'c1', name: 'Halden & Co', kind: 'client' as const },
    { id: 'c2', name: 'Bramwell Group', kind: 'client' as const },
  ];

  it('matches a name through the bank’s punctuation-free shouting', () => {
    const match = matchPayer('HALDENCO LTD PAYMENT 04APR', payers);
    expect(match.kind).toBe('one');
    if (match.kind === 'one') expect(match.payer.id).toBe('c1');
  });

  it('refuses to choose between two genuinely different matches', () => {
    // Two clients called Smith would otherwise have each other's money.
    const match = matchPayer('SMITH', [
      { id: 'a', name: 'Smithson', kind: 'client' },
      { id: 'b', name: 'Smithfield', kind: 'client' },
    ]);
    expect(match.kind).toBe('none');
  });

  it('treats a longer name containing a shorter one as the same payer', () => {
    const match = matchPayer('HALDENANDCO PAYMENT', [
      { id: 'a', name: 'Halden', kind: 'client' },
      { id: 'b', name: 'Halden and Co', kind: 'client' },
    ]);
    expect(match.kind).toBe('one');
    if (match.kind === 'one') expect(match.payer.id).toBe('b');
  });

  it('ignores a name too short to be distinctive', () => {
    // A two-character name would match half the statement.
    const match = matchPayer('PAYMENT FROM AB LTD', [
      { id: 'a', name: 'AB', kind: 'client' },
    ]);
    expect(match.kind).toBe('none');
  });

  it('finds nothing in a description with no name in it', () => {
    expect(matchPayer('FASTER PAYMENT 0417', payers).kind).toBe('none');
  });
});

describe('stripForMatching', () => {
  it('reduces a name to letters and digits', () => {
    expect(stripForMatching('Halden & Co.')).toBe('haldenco');
    expect(stripForMatching('A1 Cars (London) Ltd')).toBe('a1carslondonltd');
  });
});

describe('wouldAlsoMatch', () => {
  const transactions = [
    { description: 'SHELL FILLING 1', amountPence: -1000 },
    { description: 'SHELL FILLING 2', amountPence: -2000 },
    { description: 'BP GARAGE', amountPence: -3000 },
    // Same phrase, wrong direction: a refund is not a fuel purchase.
    { description: 'SHELL REFUND', amountPence: 1000 },
  ];

  it('counts what a proposed rule would catch, direction included', () => {
    expect(wouldAlsoMatch('shell', transactions, 'FUEL')).toBe(2);
  });

  it('counts nothing for a blank phrase', () => {
    expect(wouldAlsoMatch('  ', transactions, 'FUEL')).toBe(0);
  });
});
