import { describe, expect, it } from 'vitest';
import {
  formatGBP,
  formatMoney,
  InvalidMoneyError,
  marginPct,
  minorUnitDigits,
  parseGBP,
  parseMoney,
  roundPence,
  sumPence,
  tryParseMoney,
} from './money';

describe('roundPence', () => {
  it('leaves whole pence alone', () => {
    expect(roundPence(12550)).toBe(12550);
    expect(roundPence(0)).toBe(0);
    expect(roundPence(-99)).toBe(-99);
  });

  it('rounds half away from zero, not half up', () => {
    expect(roundPence(2.5)).toBe(3);
    expect(roundPence(-2.5)).toBe(-3);
    expect(roundPence(3.5)).toBe(4);
    expect(roundPence(-3.5)).toBe(-4);
  });

  it('rounds below and above the half normally', () => {
    expect(roundPence(2.49)).toBe(2);
    expect(roundPence(2.51)).toBe(3);
    expect(roundPence(-2.49)).toBe(-2);
    expect(roundPence(-2.51)).toBe(-3);
  });

  it('normalises negative zero so assertions and totals compare equal', () => {
    expect(Object.is(roundPence(-0.4), 0)).toBe(true);
    expect(Object.is(roundPence(-0), 0)).toBe(true);
  });

  it('rejects non-finite input rather than producing NaN pence', () => {
    expect(() => roundPence(Number.NaN)).toThrow(RangeError);
    expect(() => roundPence(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('computes VAT identically on an invoice and its credit note', () => {
    const net = 12345;
    const vat = roundPence((net * 20) / 100);
    const creditVat = roundPence((-net * 20) / 100);
    expect(vat).toBe(2469);
    expect(creditVat).toBe(-2469);
    expect(vat + creditVat).toBe(0);
  });
});

describe('formatMoney / formatGBP', () => {
  it('renders pence as pounds', () => {
    expect(formatGBP(12550)).toBe('£125.50');
    expect(formatGBP(0)).toBe('£0.00');
    expect(formatGBP(5)).toBe('£0.05');
    expect(formatGBP(100000)).toBe('£1,000.00');
  });

  it('renders negatives for credit notes', () => {
    expect(formatGBP(-12550)).toBe('-£125.50');
  });

  it('omits the symbol when asked, for spreadsheet cells', () => {
    expect(formatMoney(12550, { bare: true })).toBe('125.50');
  });

  it('follows the configured currency rather than a hardcoded pound', () => {
    expect(formatMoney(12550, { currency: 'EUR', locale: 'en-IE' })).toBe(
      '€125.50',
    );
    expect(formatMoney(12550, { currency: 'USD', locale: 'en-US' })).toBe(
      '$125.50',
    );
  });

  it('respects currencies with no minor unit', () => {
    expect(minorUnitDigits('JPY', 'en-GB')).toBe(0);
    // No decimal part, and en-GB disambiguates the yen sign as "JP¥".
    expect(formatMoney(12550, { currency: 'JPY', locale: 'en-GB' })).toBe(
      'JP¥12,550',
    );
  });

  it('rejects non-finite input', () => {
    expect(() => formatGBP(Number.NaN)).toThrow(RangeError);
  });
});

describe('parseMoney / parseGBP', () => {
  it('accepts what a user actually types', () => {
    expect(parseGBP('125.50')).toBe(12550);
    expect(parseGBP('£125.50')).toBe(12550);
    expect(parseGBP(' £125.50 ')).toBe(12550);
    expect(parseGBP('125')).toBe(12500);
    expect(parseGBP('.5')).toBe(50);
    expect(parseGBP('0')).toBe(0);
  });

  it('strips group separators', () => {
    expect(parseGBP('1,234.56')).toBe(123456);
    expect(parseGBP('£1,000')).toBe(100000);
  });

  it('handles negatives', () => {
    expect(parseGBP('-12.50')).toBe(-1250);
    expect(parseGBP('-£12.50')).toBe(-1250);
  });

  it('round-trips with formatGBP', () => {
    for (const pence of [0, 5, 99, 12550, 123456, -12550]) {
      expect(parseGBP(formatGBP(pence))).toBe(pence);
    }
  });

  it('rounds a half penny away from zero rather than truncating', () => {
    expect(parseGBP('12.505')).toBe(1251);
    expect(parseGBP('-12.505')).toBe(-1251);
    expect(parseGBP('12.504')).toBe(1250);
  });

  it('rejects anything that is not an amount', () => {
    expect(() => parseGBP('')).toThrow(InvalidMoneyError);
    expect(() => parseGBP('abc')).toThrow(InvalidMoneyError);
    expect(() => parseGBP('£')).toThrow(InvalidMoneyError);
    expect(() => parseGBP('12.3.4')).toThrow(InvalidMoneyError);
    expect(() => parseGBP('-')).toThrow(InvalidMoneyError);
  });

  it('tryParseMoney returns null instead of throwing', () => {
    expect(tryParseMoney('nonsense')).toBeNull();
    expect(tryParseMoney('12.50')).toBe(1250);
  });

  it('parses in the configured currency, not always pence', () => {
    expect(parseMoney('12550', { currency: 'JPY', locale: 'en-GB' })).toBe(
      12550,
    );
  });
});

describe('marginPct', () => {
  it('returns a percentage to two decimal places', () => {
    expect(marginPct(1842500, 638500)).toBe(34.65);
    expect(marginPct(10000, 2500)).toBe(25);
  });

  it('is negative on a loss-making job', () => {
    expect(marginPct(10000, -2500)).toBe(-25);
  });

  it('returns null on zero revenue rather than pretending the margin is 0%', () => {
    // An unpriced job has no margin. Reporting 0% is the silent-zero defect
    // this system exists to fix.
    expect(marginPct(0, 0)).toBeNull();
    expect(marginPct(0, -5000)).toBeNull();
  });
});

describe('sumPence', () => {
  it('sums, treating null and undefined as zero', () => {
    expect(sumPence(12500, 1500, null, undefined, 0)).toBe(14000);
    expect(sumPence()).toBe(0);
  });
});
