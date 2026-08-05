import { describe, expect, it } from 'vitest';
import {
  penceToField,
  quoteIsWorthAsking,
} from './quote-client';
import {
  locationSchema,
  parsePostcodes,
  penceFrom,
  rateCardSchema,
  rateRuleSchema,
  zoneSchema,
} from './schema';

describe('parsePostcodes', () => {
  it('takes prefixes however they were typed', () => {
    expect(parsePostcodes('tw6\nub7, TW14;  sl3')).toEqual([
      'TW6',
      'UB7',
      'TW14',
      'SL3',
    ]);
  });

  it('de-duplicates, because two rows saying the same thing make the longest-prefix match ambiguous', () => {
    expect(parsePostcodes('SW1, sw1 , SW1A')).toEqual(['SW1', 'SW1A']);
  });

  it('strips punctuation and whitespace inside a prefix', () => {
    expect(parsePostcodes('  TW-6  ')).toEqual(['TW6']);
  });

  it('is empty for nothing at all', () => {
    expect(parsePostcodes('')).toEqual([]);
    expect(parsePostcodes(null)).toEqual([]);
  });
});

describe('penceFrom', () => {
  it.each([
    ['125.50', 12_550],
    ['£125.50', 12_550],
    ['1,234.56', 123_456],
    ['80', 8000],
    ['-12.50', -1250],
  ])('%s becomes %i pence', (input, expected) => {
    expect(penceFrom(input)).toBe(expected);
  });

  it('treats blank as nothing charged rather than as invalid', () => {
    expect(penceFrom('')).toBe(0);
    expect(penceFrom(null)).toBe(0);
  });
});

describe('zoneSchema', () => {
  it('needs a name', () => {
    expect(zoneSchema.safeParse({ name: 'H' }).success).toBe(false);
    expect(zoneSchema.safeParse({ name: 'Heathrow' }).success).toBe(true);
  });
});

describe('rateCardSchema', () => {
  it('accepts an open-ended card', () => {
    const parsed = rateCardSchema.safeParse({
      name: 'Standard 2026',
      activeFrom: '2026-01-01',
      activeTo: '',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.activeTo).toBeNull();
  });

  it('refuses a card that stops applying before it starts', () => {
    const parsed = rateCardSchema.safeParse({
      name: 'Backwards',
      activeFrom: '2026-06-01',
      activeTo: '2026-01-01',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('rateRuleSchema', () => {
  const base = {
    jobType: 'TRANSFER',
    vehicleClass: '',
    fromZoneId: '',
    toZoneId: '',
    baseFare: '85.00',
    perHour: '',
    minimumHours: '',
    freeWaitMinutes: '15',
    waitPerMinute: '',
    driverBase: '',
    driverPerHour: '',
    driverPctOfFare: '',
    priority: '0',
  };

  it('turns blank optional fields into null rather than zero', () => {
    // `z.coerce.number()` would make `''` into `0`, which for a minimum-hours
    // field is a statement rather than an absence.
    const parsed = rateRuleSchema.parse(base);
    expect(parsed.minimumHours).toBeNull();
    expect(parsed.driverPctOfFare).toBeNull();
    expect(parsed.fromZoneId).toBeNull();
    expect(parsed.vehicleClass).toBeNull();
  });

  it('keeps a zero that was actually typed', () => {
    const parsed = rateRuleSchema.parse({ ...base, driverPctOfFare: '0' });
    expect(parsed.driverPctOfFare).toBe(0);
  });

  it('refuses a driver percentage outside 0–100', () => {
    expect(
      rateRuleSchema.safeParse({ ...base, driverPctOfFare: '140' }).success,
    ).toBe(false);
  });

  it('refuses an amount that is not money', () => {
    expect(rateRuleSchema.safeParse({ ...base, baseFare: 'lots' }).success).toBe(
      false,
    );
  });

  it('accepts a percentage and a job type together', () => {
    const parsed = rateRuleSchema.parse({
      ...base,
      jobType: 'AS_DIRECTED',
      perHour: '45.00',
      minimumHours: '3',
      driverPctOfFare: '70',
    });
    expect(parsed.jobType).toBe('AS_DIRECTED');
    expect(parsed.minimumHours).toBe(3);
    expect(parsed.driverPctOfFare).toBe(70);
  });
});

describe('locationSchema', () => {
  it('needs a name and an address', () => {
    expect(
      locationSchema.safeParse({ label: 'Heathrow T5', address: '' }).success,
    ).toBe(false);
    expect(
      locationSchema.safeParse({
        label: 'Heathrow T5',
        address: 'Terminal 5, Heathrow',
      }).success,
    ).toBe(true);
  });
});

describe('quoteIsWorthAsking', () => {
  const full = {
    jobType: 'TRANSFER',
    scheduledDate: '2026-08-05',
    scheduledTime: '14:30',
    pickupText: 'The Dorchester',
    dropoffText: 'Heathrow Terminal 5',
  };

  it('is true once there is a route and a time', () => {
    expect(quoteIsWorthAsking(full)).toBe(true);
  });

  it.each(['pickupText', 'dropoffText', 'scheduledDate', 'scheduledTime'])(
    'is false without %s',
    (field) => {
      expect(quoteIsWorthAsking({ ...full, [field]: '' })).toBe(false);
    },
  );

  it('is false for whitespace, which is not an address', () => {
    expect(quoteIsWorthAsking({ ...full, pickupText: '   ' })).toBe(false);
  });
});

describe('penceToField', () => {
  it('renders pence as the price fields hold it', () => {
    expect(penceToField(12_550)).toBe('125.50');
    expect(penceToField(8000)).toBe('80.00');
  });

  it('is blank when the rule says nothing about driver pay', () => {
    expect(penceToField(null)).toBe('');
  });
});
