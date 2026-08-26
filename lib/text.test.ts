import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  normaliseName,
  normalisePhone,
  normalisedSearchTerm,
  normaliseRegistration,
  tidy,
} from './text';

describe('normaliseName', () => {
  it('collapses the variants the legacy system stored separately', () => {
    // "MR Yinka" and "Mr yinka" were two different clients in the old system.
    const variants = ['MR Yinka', 'Mr yinka', 'Mr. Yinka', '  mr   YINKA  '];
    const normalised = variants.map(normaliseName);
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('yinka');
  });

  it('strips a leading honorific only', () => {
    expect(normaliseName('Dr Sarah Doctor')).toBe('sarah doctor');
    expect(normaliseName('Professor Ada Lovelace')).toBe('ada lovelace');
  });

  it('keeps an honorific that is the entire name', () => {
    // Otherwise every such record normalises to '' and matches every other.
    expect(normaliseName('Mr')).toBe('mr');
  });

  it('folds accents so Renée and Renee match', () => {
    expect(normaliseName('Renée Dubois')).toBe(normaliseName('Renee Dubois'));
  });

  it('keeps apostrophised names as one word', () => {
    expect(normaliseName("O'Brien")).toBe('obrien');
    expect(normaliseName('O’Brien')).toBe('obrien');
  });

  it('treats other punctuation as a separator', () => {
    expect(normaliseName('Smith-Jones')).toBe('smith jones');
    expect(normaliseName('Acme Ltd.')).toBe('acme ltd');
  });

  it('keeps digits, which appear in company names', () => {
    expect(normaliseName('Cars 4 U Ltd')).toBe('cars 4 u ltd');
  });

  it('returns an empty string for empty input', () => {
    expect(normaliseName('')).toBe('');
    expect(normaliseName('   ')).toBe('');
  });

  it('does not merge different given names', () => {
    expect(normaliseName('John Smith')).not.toBe(normaliseName('Jane Smith'));
    expect(normaliseName('Acme Cars')).not.toBe(normaliseName('Acme Coaches'));
  });

  it('does collide Mr and Mrs of the same surname — accepted, and why', () => {
    // Stripping honorifics is what the spec asks for, and it is what merges
    // "MR Yinka" with "Mr yinka". The cost is that a couple sharing a surname
    // collides. That is tolerable precisely because a duplicate is a *warning*
    // with a link to the existing record, never a block — the operator sees
    // both and decides. If this ever became a hard constraint, the honorific
    // would have to be kept.
    expect(normaliseName('Mr Williams')).toBe(normaliseName('Mrs Williams'));
  });
});

describe('normaliseRegistration', () => {
  it('ignores spacing and case', () => {
    for (const plate of ['KR22 RRZ', 'kr22rrz', 'KR22-RRZ', ' kr22 RRZ ']) {
      expect(normaliseRegistration(plate)).toBe('KR22RRZ');
    }
  });

  it('leaves an already-normalised plate alone', () => {
    expect(normaliseRegistration('KR22RRZ')).toBe('KR22RRZ');
  });

  it('does not merge different plates', () => {
    expect(normaliseRegistration('KR22 RRZ')).not.toBe(
      normaliseRegistration('KR22 RRX'),
    );
  });
});

describe('normalisePhone', () => {
  it('matches the same number written three ways', () => {
    const forms = ['+44 7700 900123', '07700 900123', '07700900123'];
    const normalised = forms.map(normalisePhone);
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('07700900123');
  });

  it('handles the 0044 international prefix', () => {
    expect(normalisePhone('00447700900123')).toBe('07700900123');
  });

  it('leaves a non-UK number recognisable', () => {
    expect(normalisePhone('+1 555 0100')).toBe('15550100');
  });

  it('does not merge different numbers', () => {
    expect(normalisePhone('07700900123')).not.toBe(normalisePhone('07700900124'));
  });
});

describe('tidy', () => {
  it('trims and collapses without touching case', () => {
    expect(tidy('  The   Dorchester ')).toBe('The Dorchester');
  });
});

describe('emptyToNull', () => {
  it('turns blank strings into null so optional columns stay null', () => {
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('   ')).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
  });

  it('tidies a real value', () => {
    expect(emptyToNull('  hello  world ')).toBe('hello world');
  });
});

describe('normalisedSearchTerm', () => {
  it('returns the normalised term when there is one', () => {
    expect(normalisedSearchTerm('07700 900123', normalisePhone)).toBe('07700900123');
    expect(normalisedSearchTerm('dp09 5612', normaliseRegistration)).toBe('DP095612');
  });

  it('returns null when normalising leaves nothing', () => {
    /*
     * The whole point, and a real defect rather than a hypothetical one.
     *
     * `contains: ''` is `LIKE '%%'` — it matches every row, not none. The
     * driver list ran `phone contains normalisePhone(q)` unguarded, so
     * searching a *name* matched all 152 drivers instead of the 82 whose name
     * held the word: the list came back looking untouched, which reads as a
     * search box that does nothing.
     */
    expect(normalisedSearchTerm('Dispatch', normalisePhone)).toBeNull();
    expect(normalisedSearchTerm('Smith', normalisePhone)).toBeNull();
    expect(normalisedSearchTerm('---', normaliseRegistration)).toBeNull();
  });

  it('keeps a term that is only partly strippable', () => {
    // "DRV-0001" holds digits, so it is still worth trying as a phone.
    expect(normalisedSearchTerm('DRV-0001', normalisePhone)).toBe('0001');
  });
});
