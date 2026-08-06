import { describe, expect, it } from 'vitest';
import {
  buildJobWhere,
  duplicateDefaults,
  isSortableJobKey,
  jobSchema,
  scheduledAtFrom,
  UNPRICED_WHERE,
} from './jobs';

/**
 * The parsing and query-building halves of the job module, which is where the
 * money and timezone rules actually bite.
 */

const valid = {
  jobType: 'TRANSFER' as const,
  scheduledDate: '2026-08-04',
  scheduledTime: '14:30',
  pickupText: 'The Dorchester',
  dropoffText: 'Heathrow T5',
};

describe('jobSchema pricing', () => {
  it('parses pounds from the form into integer pence', () => {
    const parsed = jobSchema.parse({ ...valid, clientPricePence: '125.50' });
    expect(parsed.clientPricePence).toBe(12550);
  });

  it('leaves a blank price as null, not zero', () => {
    // This distinction is the entire point of the phase. Null is "nobody
    // said"; zero is "this was free", which needs a reason.
    const parsed = jobSchema.parse({ ...valid, clientPricePence: '' });
    expect(parsed.clientPricePence).toBeNull();
  });

  it('treats an omitted price as null', () => {
    expect(jobSchema.parse(valid).clientPricePence).toBeNull();
  });

  it('accepts an explicit zero, which is a statement rather than a gap', () => {
    const parsed = jobSchema.parse({ ...valid, clientPricePence: '0' });
    expect(parsed.clientPricePence).toBe(0);
  });

  it('rejects a negative price', () => {
    expect(() => jobSchema.parse({ ...valid, clientPricePence: '-10' })).toThrow();
  });

  it('rejects a price that is not a number', () => {
    expect(() => jobSchema.parse({ ...valid, clientPricePence: 'lots' })).toThrow();
  });

  it('parses the driver price the same way', () => {
    const parsed = jobSchema.parse({
      ...valid,
      clientPricePence: '125.50',
      driverPricePence: '80',
    });
    expect(parsed.driverPricePence).toBe(8000);
  });
});

describe('jobSchema validation', () => {
  it('requires a pickup and a destination', () => {
    expect(() => jobSchema.parse({ ...valid, pickupText: '' })).toThrow();
    expect(() => jobSchema.parse({ ...valid, dropoffText: '   ' })).toThrow();
  });

  it('requires a well-formed date and time', () => {
    expect(() => jobSchema.parse({ ...valid, scheduledDate: '04/08/2026' })).toThrow();
    expect(() => jobSchema.parse({ ...valid, scheduledTime: '2.30pm' })).toThrow();
  });

  it('accepts a flight number on an airport transfer', () => {
    const parsed = jobSchema.parse({
      ...valid,
      jobType: 'AIRPORT_TRANSFER',
      flightNumber: 'BA286',
    });
    expect(parsed.flightNumber).toBe('BA286');
  });

  it('refuses a flight number on a non-airport job rather than dropping it', () => {
    // Silently discarding it hides a mis-selected job type.
    expect(() =>
      jobSchema.parse({ ...valid, jobType: 'TRANSFER', flightNumber: 'BA286' }),
    ).toThrow();
  });

  it('turns blank optional ids into null so Prisma does not get an empty string', () => {
    const parsed = jobSchema.parse({ ...valid, clientId: '', driverId: '' });
    expect(parsed.clientId).toBeNull();
    expect(parsed.driverId).toBeNull();
  });

  it('turns a blank passenger count into null rather than zero passengers', () => {
    expect(jobSchema.parse({ ...valid, passengerCount: '' }).passengerCount).toBeNull();
    expect(jobSchema.parse({ ...valid, passengerCount: '3' }).passengerCount).toBe(3);
  });
});

describe('scheduledAtFrom', () => {
  it('reads the form as London time and stores UTC', () => {
    // 4 August is British Summer Time: London is UTC+1, so 14:30 local is
    // 13:30Z. Storing 14:30Z would put every summer pickup an hour late.
    const at = scheduledAtFrom({ scheduledDate: '2026-08-04', scheduledTime: '14:30' });
    expect(at.toISOString()).toBe('2026-08-04T13:30:00.000Z');
  });

  it('handles a winter date, when London is UTC', () => {
    const at = scheduledAtFrom({ scheduledDate: '2026-01-14', scheduledTime: '14:30' });
    expect(at.toISOString()).toBe('2026-01-14T14:30:00.000Z');
  });

  it('honours a configured non-UK timezone', () => {
    // Locale is configuration, not a constant.
    const at = scheduledAtFrom(
      { scheduledDate: '2026-08-04', scheduledTime: '14:30' },
      'UTC',
    );
    expect(at.toISOString()).toBe('2026-08-04T14:30:00.000Z');
  });
});

describe('buildJobWhere', () => {
  const noFilters = {
    status: null,
    jobType: null,
    driverId: null,
    clientId: null,
    accountId: null,
    vehicleId: null,
    from: null,
    to: null,
    unpricedOnly: false,
  };

  it('builds an empty clause when nothing is filtered', () => {
    expect(buildJobWhere({ q: null }, noFilters)).toEqual({});
  });

  it('filters by each simple field', () => {
    const where = buildJobWhere({ q: null }, {
      ...noFilters,
      status: 'COMPLETED',
      jobType: 'AIRPORT_TRANSFER',
      driverId: 'drv_1',
    });
    expect(where.status).toBe('COMPLETED');
    expect(where.jobType).toBe('AIRPORT_TRANSFER');
    expect(where.driverId).toBe('drv_1');
  });

  it('converts a date range from London days to UTC instants', () => {
    // The operator types a London date. In summer the day starts at 23:00Z
    // the night before — using midnight UTC would drop the first hour of
    // every range.
    const where = buildJobWhere({ q: null }, {
      ...noFilters,
      from: '2026-08-04',
      to: '2026-08-04',
    });
    const range = where.scheduledAt as { gte: Date; lte: Date };
    expect(range.gte.toISOString()).toBe('2026-08-03T23:00:00.000Z');
    expect(range.lte.toISOString()).toBe('2026-08-04T22:59:59.000Z');
  });

  it('accepts an open-ended range', () => {
    const where = buildJobWhere({ q: null }, { ...noFilters, from: '2026-08-04' });
    const range = where.scheduledAt as { gte?: Date; lte?: Date };
    expect(range.gte).toBeInstanceOf(Date);
    expect(range.lte).toBeUndefined();
  });

  it('adds the unpriced clause only when asked', () => {
    expect(buildJobWhere({ q: null }, noFilters).AND).toBeUndefined();
    const where = buildJobWhere({ q: null }, { ...noFilters, unpricedOnly: true });
    expect(where.AND).toContainEqual(UNPRICED_WHERE);
  });

  it('searches reference, addresses and related names', () => {
    const where = buildJobWhere({ q: 'Dorchester' }, noFilters);
    const clause = (where.AND as Array<{ OR?: unknown[] }>)[0];
    expect(clause?.OR ?? []).toHaveLength(6);
  });

  it('combines a search with the unpriced toggle rather than replacing it', () => {
    const where = buildJobWhere({ q: 'BA286' }, { ...noFilters, unpricedOnly: true });
    expect(where.AND).toHaveLength(2);
  });
});

describe('UNPRICED_WHERE', () => {
  it('treats null and non-positive prices as unpriced, unless a reason exists', () => {
    // Must stay in step with hasPriceOrReason in job-status.ts.
    expect(UNPRICED_WHERE.AND[0]?.OR).toEqual([
      { clientPricePence: null },
      { clientPricePence: { lte: 0 } },
    ]);
    expect(UNPRICED_WHERE.AND[1]).toEqual({ zeroValueReason: null });
  });
});

describe('isSortableJobKey', () => {
  it('accepts the documented sort columns', () => {
    for (const key of ['scheduledAt', 'reference', 'client', 'driver', 'grossProfit']) {
      expect(isSortableJobKey(key), key).toBe(true);
    }
  });

  it('rejects anything else, so a crafted URL cannot reach an arbitrary column', () => {
    expect(isSortableJobKey('internalNotes')).toBe(false);
    expect(isSortableJobKey('__proto__')).toBe(false);
    expect(isSortableJobKey(null)).toBe(false);
  });
});

describe('duplicateDefaults', () => {
  const source = {
    clientId: 'cli_1',
    accountId: 'acc_1',
    jobType: 'TRANSFER' as const,
    pickupText: 'The Dorchester',
    pickupPostcode: 'W1K 1QA',
    pickupLat: 51.5074,
    pickupLng: -0.1523,
    dropoffText: 'Heathrow T5',
    dropoffPostcode: 'TW6 2GA',
    dropoffLat: 51.4701,
    dropoffLng: -0.4543,
    viaText: null,
    driverId: 'drv_1',
    vehicleId: 'veh_1',
    passengerName: 'A Passenger',
    passengerPhone: '07700900123',
    passengerCount: 2,
    luggageCount: 3,
    clientPricePence: 12550,
    driverPricePence: 8000,
    notes: 'Meet at the front desk',
  };

  it('copies the booking but clears the date', () => {
    // A duplicate that kept its date would book something for last Tuesday.
    const defaults = duplicateDefaults(source);
    expect(defaults.scheduledDate).toBe('');
    expect(defaults.scheduledTime).toBe('');
    expect(defaults.pickupText).toBe('The Dorchester');
    expect(defaults.clientPricePence).toBe(12550);
  });

  it('swaps the addresses for a return journey', () => {
    const defaults = duplicateDefaults(source, { swap: true });
    expect(defaults.pickupText).toBe('Heathrow T5');
    expect(defaults.dropoffText).toBe('The Dorchester');
  });

  it('swaps the postcode and coordinates with the text', () => {
    // Leaving these behind would price the return leg from the outbound
    // leg's zone, which is the one journey where that is reliably wrong.
    const defaults = duplicateDefaults(source, { swap: true });
    expect(defaults.pickupPostcode).toBe('TW6 2GA');
    expect(defaults.dropoffPostcode).toBe('W1K 1QA');
    expect(defaults.pickupLat).toBe('51.4701');
    expect(defaults.dropoffLat).toBe('51.5074');
  });

  it('renders nulls as empty strings the form can bind to', () => {
    const defaults = duplicateDefaults({ ...source, clientId: null, viaText: null });
    expect(defaults.clientId).toBe('');
    expect(defaults.viaText).toBe('');
  });
});
