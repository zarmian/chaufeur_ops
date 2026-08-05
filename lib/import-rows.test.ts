import { describe, expect, it } from 'vitest';
import {
  findDuplicatesInFile,
  parseImportDate,
  validateClientRow,
  validateDriverRow,
  validateVehicleRow,
} from './import-rows';
import { normaliseName } from './text';

/**
 * Row validation, which decides whether 195 records load or the operator
 * gives up and types them by hand.
 *
 * The two rules worth stating: a blank expiry is *allowed*, because the
 * legacy system's whole problem was documents with no dates and refusing
 * those rows would push people into inventing them; and an unrecognised
 * value is refused rather than guessed, because a silently defaulted vehicle
 * class is a wrong record nobody knows to check.
 */

describe('parseImportDate', () => {
  it('reads the ISO form', () => {
    const result = parseImportDate('2027-06-30');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toISOString()).toBe('2027-06-30T00:00:00.000Z');
  });

  it('reads the British slash form day-first', () => {
    // `06/07/2027` from a UK spreadsheet means July. Guessing the other way
    // would put an MOT expiry eleven months out and nobody would notice
    // until it lapsed.
    const result = parseImportDate('06/07/2027');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.getUTCMonth()).toBe(6);
  });

  it('accepts a dashed day-first form too', () => {
    const result = parseImportDate('30-06-2027');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.getUTCDate()).toBe(30);
  });

  it('treats a blank as absent, not invalid', () => {
    // The rule the whole importer turns on.
    for (const blank of ['', '   ']) {
      const result = parseImportDate(blank);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    }
  });

  it('refuses a date that never existed', () => {
    expect(parseImportDate('31/02/2027').ok).toBe(false);
    expect(parseImportDate('45/13/2027').ok).toBe(false);
  });

  it('refuses something that is not a date at all', () => {
    const result = parseImportDate('next Tuesday');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/YYYY-MM-DD/);
  });
});

describe('validateDriverRow', () => {
  const good = {
    name: 'Sam Okafor',
    phone: '07700 900123',
    email: 'sam@example.com',
    dvlalicenceexpiry: '2028-04-30',
    phvbadgeexpiry: '2027-11-15',
  };

  it('accepts a complete row', () => {
    const outcome = validateDriverRow(good, 2);
    expect(outcome.errors).toEqual([]);
    expect(outcome.value?.name).toBe('Sam Okafor');
    expect(outcome.value?.status).toBe('ACTIVE');
  });

  it('folds the phone into the natural key', () => {
    // `+44 7700 900123` and `07700900123` are the same driver.
    const a = validateDriverRow({ ...good, phone: '+44 7700 900123' }, 2);
    const b = validateDriverRow({ ...good, phone: '07700900123' }, 3);
    expect(a.value?.normalisedPhone).toBe(b.value?.normalisedPhone);
  });

  it('needs a name and a phone', () => {
    const outcome = validateDriverRow({ ...good, name: '', phone: '' }, 2);
    expect(outcome.value).toBeNull();
    expect(outcome.errors.map((e) => e.column)).toEqual(['name', 'phone']);
    expect(outcome.errors[0]!.line).toBe(2);
  });

  it('imports a driver with no expiry dates at all', () => {
    // They land in the compliance backlog, which is where an undated
    // document belongs. Refusing the row would push someone to invent one.
    const outcome = validateDriverRow(
      { name: 'Sam', phone: '07700900123', dvlalicenceexpiry: '', phvbadgeexpiry: '' },
      2,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.value?.dvlaLicenceExpiry).toBeNull();
    expect(outcome.value?.phvBadgeExpiry).toBeNull();
  });

  it('reports every problem in the row, not just the first', () => {
    // One error per attempt would mean five uploads to fix one row.
    const outcome = validateDriverRow(
      { name: '', phone: '', email: 'nope', dvlalicenceexpiry: 'soon' },
      7,
    );
    expect(outcome.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses an unrecognised status rather than defaulting it', () => {
    const outcome = validateDriverRow({ ...good, status: 'on holiday' }, 2);
    expect(outcome.value).toBeNull();
    expect(outcome.errors[0]!.message).toMatch(/ACTIVE/);
  });

  it('accepts a status in any casing', () => {
    expect(validateDriverRow({ ...good, status: 'suspended' }, 2).value?.status).toBe(
      'SUSPENDED',
    );
  });

  it('carries the vehicle registration through for linking', () => {
    const outcome = validateDriverRow(
      { ...good, vehicleregistration: 'AB12 CDE' },
      2,
    );
    expect(outcome.value?.vehicleRegistration).toBe('AB12 CDE');
  });
});

describe('validateVehicleRow', () => {
  const good = {
    registration: 'AB12 CDE',
    make: 'Mercedes-Benz',
    model: 'E-Class',
  };

  it('accepts a minimal row and defaults the rest', () => {
    const outcome = validateVehicleRow(good, 2);
    expect(outcome.errors).toEqual([]);
    expect(outcome.value?.seats).toBe(4);
    expect(outcome.value?.vehicleClass).toBe('EXECUTIVE');
    // Additive by default, matching how the fleet already behaves.
    expect(outcome.value?.ownership).toBe('DRIVER_OWNED');
  });

  it('normalises the registration for matching but keeps it readable', () => {
    const outcome = validateVehicleRow({ ...good, registration: 'ab12cde' }, 2);
    expect(outcome.value?.normalisedRegistration).toBe('AB12CDE');
    expect(outcome.value?.registration).toBe('AB12CDE');
  });

  it('needs a registration, a make and a model', () => {
    const outcome = validateVehicleRow(
      { registration: '', make: '', model: '' },
      2,
    );
    expect(outcome.errors.map((e) => e.column)).toEqual([
      'registration',
      'make',
      'model',
    ]);
  });

  it('refuses a seat count that is not one', () => {
    for (const seats of ['0', '99', 'four', '4.5']) {
      expect(validateVehicleRow({ ...good, seats }, 2).value, seats).toBeNull();
    }
  });

  it('accepts an ownership written with a space', () => {
    const outcome = validateVehicleRow({ ...good, ownership: 'driver owned' }, 2);
    expect(outcome.value?.ownership).toBe('DRIVER_OWNED');
  });

  it('refuses a class it does not recognise', () => {
    // Defaulting silently would produce a wrong record nobody knows to check.
    const outcome = validateVehicleRow({ ...good, class: 'LIMO' }, 2);
    expect(outcome.value).toBeNull();
  });
});

describe('validateClientRow', () => {
  it('matches on the name plus a contact detail', () => {
    // Name alone would merge two different people called John Smith.
    const a = validateClientRow({ name: 'John Smith', contactemail: 'j@a.test' }, 2);
    const b = validateClientRow({ name: 'John Smith', contactemail: 'j@b.test' }, 3);
    expect(a.value?.matchKey).not.toBe(b.value?.matchKey);
  });

  it('matches the same client written differently', () => {
    const a = validateClientRow({ name: 'John Smith', contactemail: 'J@A.test' }, 2);
    const b = validateClientRow(
      { name: '  john   smith ', contactemail: 'j@a.test' },
      3,
    );
    expect(a.value?.matchKey).toBe(b.value?.matchKey);
  });

  it('falls back to the phone, then to the name alone', () => {
    expect(
      validateClientRow({ name: 'Acme', contactphone: '020 7946 0000' }, 2).value
        ?.matchKey,
    ).toContain('02079460000');
    // `normaliseName` from lib/text.ts, so an imported client dedupes the
    // same way one typed in by hand does.
    expect(validateClientRow({ name: 'Acme' }, 2).value?.matchKey).toBe(
      normaliseName('Acme'),
    );
  });

  it('needs a name', () => {
    expect(validateClientRow({ name: '' }, 2).value).toBeNull();
  });

  it('refuses a malformed email in either column', () => {
    expect(
      validateClientRow({ name: 'Acme', contactemail: 'not-an-email' }, 2).value,
    ).toBeNull();
    expect(
      validateClientRow({ name: 'Acme', billingemail: 'also-not' }, 2).value,
    ).toBeNull();
  });

  it('defaults the payment terms and refuses a nonsense one', () => {
    expect(validateClientRow({ name: 'Acme' }, 2).value?.paymentTermsDays).toBe(14);
    expect(
      validateClientRow({ name: 'Acme', paymenttermsdays: '30' }, 2).value
        ?.paymentTermsDays,
    ).toBe(30);
    expect(
      validateClientRow({ name: 'Acme', paymenttermsdays: 'a month' }, 2).value,
    ).toBeNull();
  });
});

describe('findDuplicatesInFile', () => {
  const rows = (...keys: string[]) =>
    keys.map((key, index) => ({
      line: index + 2,
      value: { key },
      errors: [],
    }));

  it('reports the second occurrence and names the first', () => {
    // Two lines with the same registration usually means a block was pasted
    // twice. Letting the second quietly overwrite the first is how the wrong
    // data wins.
    const errors = findDuplicatesInFile(rows('a', 'b', 'a'), (v) => v.key);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(4);
    expect(errors[0]!.message).toMatch(/line 2/);
  });

  it('says nothing about a file with no duplicates', () => {
    expect(findDuplicatesInFile(rows('a', 'b', 'c'), (v) => v.key)).toEqual([]);
  });

  it('ignores rows that already failed validation', () => {
    const outcomes = [
      { line: 2, value: null, errors: [] },
      { line: 3, value: null, errors: [] },
    ];
    expect(findDuplicatesInFile(outcomes, (v: { key: string }) => v.key)).toEqual([]);
  });
});
