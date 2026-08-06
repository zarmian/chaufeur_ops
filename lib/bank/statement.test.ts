import { describe, expect, it } from 'vitest';
import {
  detectLayout,
  fingerprintOf,
  parseAmountPence,
  parseStatement,
  parseStatementDate,
} from './statement';

/**
 * Reading a bank statement.
 *
 * The failure this is really guarding against is a sign inversion. A debit
 * column holds a positive number meaning money *out*, and a parser that
 * summed columns instead of understanding them would credit invoices from
 * money that left the account. So every layout is tested for the direction of
 * its amounts, not merely their magnitude.
 */

describe('parseAmountPence', () => {
  it.each([
    ['125.50', 12_550],
    ['£125.50', 12_550],
    ['1,234.56', 123_456],
    ['-12.50', -1250],
    ['80', 8000],
    ['0.01', 1],
  ])('%s is %i pence', (input, expected) => {
    expect(parseAmountPence(input)).toBe(expected);
  });

  it('reads accountants’ brackets as negative', () => {
    // At least two UK banks still emit `(12.50)` for money out.
    expect(parseAmountPence('(12.50)')).toBe(-1250);
    expect(parseAmountPence('(1,234.56)')).toBe(-123_456);
  });

  it('returns null rather than zero for anything it cannot read', () => {
    // A zero here would be a transaction that silently did nothing.
    for (const input of ['', '  ', 'n/a', 'abc', '12.345', undefined]) {
      expect(parseAmountPence(input)).toBeNull();
    }
  });
});

describe('parseStatementDate', () => {
  it('reads slashes day-first, because that is what a UK bank means', () => {
    const date = parseStatementDate('03/04/2026');
    expect(date?.toISOString().slice(0, 10)).toBe('2026-04-03');
  });

  it('reads ISO too', () => {
    expect(parseStatementDate('2026-04-03')?.toISOString().slice(0, 10)).toBe(
      '2026-04-03',
    );
  });

  it('reads two-digit years', () => {
    expect(parseStatementDate('03/04/26')?.toISOString().slice(0, 10)).toBe(
      '2026-04-03',
    );
  });

  it('rejects a date that does not exist rather than rolling it forward', () => {
    // `new Date(2026, 1, 31)` is 3 March, which would silently move a
    // transaction into the wrong month.
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementDate('45/01/2026')).toBeNull();
    expect(parseStatementDate('nonsense')).toBeNull();
  });
});

describe('detectLayout', () => {
  it('recognises each bank by its columns, not by being told', () => {
    expect(detectLayout(['Date', 'Amount', 'Memo', 'Balance'])?.name).toBe(
      'barclays',
    );
    expect(
      detectLayout([
        'Transaction Date',
        'Transaction Description',
        'Debit Amount',
        'Credit Amount',
      ])?.name,
    ).toBe('lloyds');
    expect(detectLayout(['Date', 'Description', 'Value', 'Balance'])?.name).toBe(
      'natwest',
    );
    expect(detectLayout(['Date', 'Counterparty', 'Amount (GBP)'])?.name).toBe(
      'starling',
    );
  });

  it('returns null when nothing matches', () => {
    expect(detectLayout(['when', 'howmuch', 'what'])).toBeNull();
  });
});

describe('parseStatement', () => {
  it('reads a signed-amount layout', () => {
    const parsed = parseStatement(
      [
        'Date,Amount,Memo,Balance',
        '03/04/2026,1250.00,HALDEN AND CO LTD,5000.00',
        '04/04/2026,-89.50,SHELL FILLING STN 4412,4910.50',
      ].join('\n'),
    );

    expect(parsed.layout).toBe('barclays');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.amountPence).toBe(125_000);
    expect(parsed.rows[1]?.amountPence).toBe(-8950);
    expect(parsed.rows[0]?.balancePence).toBe(500_000);
  });

  it('negates a debit column, which holds a positive number for money out', () => {
    // The sign inversion this whole file exists to prevent.
    const parsed = parseStatement(
      [
        'Transaction Date,Transaction Description,Debit Amount,Credit Amount,Balance',
        '03/04/2026,HALDEN AND CO,,1250.00,5000.00',
        '04/04/2026,SHELL FILLING STN,89.50,,4910.50',
      ].join('\n'),
    );

    expect(parsed.layout).toBe('lloyds');
    expect(parsed.rows[0]?.amountPence).toBe(125_000);
    expect(parsed.rows[1]?.amountPence).toBe(-8950);
  });

  it('reports a row it cannot read rather than skipping it silently', () => {
    // A statement that imported 2 of 3 rows without saying so is one whose
    // reconciliation will never balance and nobody will know why.
    const parsed = parseStatement(
      [
        'Date,Amount,Memo',
        '03/04/2026,1250.00,GOOD ROW',
        'not a date,50.00,BAD DATE',
        '05/04/2026,not money,BAD AMOUNT',
      ].join('\n'),
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems[0]?.line).toBe(3);
    expect(parsed.problems[0]?.reason).toContain('date');
    expect(parsed.problems[1]?.reason).toContain('amount');
  });

  it('drops a zero-value line, which is a statement artefact', () => {
    const parsed = parseStatement(
      ['Date,Amount,Memo', '03/04/2026,0.00,BALANCE BROUGHT FORWARD'].join('\n'),
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  it('de-duplicates a row repeated across a page break', () => {
    const parsed = parseStatement(
      [
        'Date,Amount,Memo',
        '03/04/2026,1250.00,HALDEN AND CO',
        '03/04/2026,1250.00,HALDEN AND CO',
      ].join('\n'),
    );
    expect(parsed.rows).toHaveLength(1);
  });

  it('reports the period it covers', () => {
    const parsed = parseStatement(
      [
        'Date,Amount,Memo',
        '10/04/2026,10.00,B',
        '03/04/2026,10.00,A',
        '20/04/2026,10.00,C',
      ].join('\n'),
    );

    expect(parsed.periodStart?.toISOString().slice(0, 10)).toBe('2026-04-03');
    expect(parsed.periodEnd?.toISOString().slice(0, 10)).toBe('2026-04-20');
  });

  it('falls back to a supplied mapping when nothing is recognised', () => {
    const parsed = parseStatement(
      ['When,How much,What', '03/04/2026,1250.00,HALDEN AND CO'].join('\n'),
      { date: 'When', description: 'What', amount: 'How much' },
    );

    expect(parsed.layout).toBe('custom');
    expect(parsed.rows[0]?.amountPence).toBe(125_000);
  });

  it('says which columns it saw when it cannot read them', () => {
    const parsed = parseStatement(['When,How much,What', '1,2,3'].join('\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems[0]?.reason).toContain('When');
  });
});

describe('fingerprintOf', () => {
  const base = {
    occurredOn: new Date('2026-04-03T00:00:00Z'),
    amountPence: 125_000,
    description: 'HALDEN AND CO LTD',
    bankRef: null,
  };

  it('is stable across re-imports of the same row', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }));
  });

  it('ignores whitespace and case in the description', () => {
    expect(fingerprintOf(base)).toBe(
      fingerprintOf({ ...base, description: 'halden   and co ltd' }),
    );
  });

  it('differs when the amount or date differs', () => {
    expect(fingerprintOf({ ...base, amountPence: 125_001 })).not.toBe(
      fingerprintOf(base),
    );
    expect(
      fingerprintOf({ ...base, occurredOn: new Date('2026-04-04T00:00:00Z') }),
    ).not.toBe(fingerprintOf(base));
  });

  it('prefers the bank’s own reference when there is one', () => {
    const withRef = fingerprintOf({ ...base, bankRef: 'FT26094ABCD' });
    expect(withRef).toBe('ref:ft26094abcd');
    // And is then insensitive to the description changing between exports.
    expect(
      fingerprintOf({ ...base, bankRef: 'FT26094ABCD', description: 'other' }),
    ).toBe(withRef);
  });
});
