import { describe, expect, it } from 'vitest';
import { financeCostKind, vehicleSchema } from './vehicles';

/**
 * Validating a vehicle before it reaches the database.
 *
 * The reason this file exists: a blank date and a mistyped amount both used to
 * *throw* out of the Server Action rather than fail validation, and a throw
 * lands on the route's error boundary as "this vehicles page could not be
 * loaded". That tells an operator the page is broken when in fact one field
 * is, and there is nothing on the screen saying which. Every optional field
 * here is checked for the blank case for that reason.
 */

const MINIMAL = {
  registration: 'LC24 YNH',
  make: 'Land Rover',
  model: 'Range Rover',
  vehicleClass: 'LUXURY',
  status: 'ACTIVE',
} as const;

const parse = (overrides: Record<string, unknown> = {}) =>
  vehicleSchema.parse({ ...MINIMAL, ...overrides });

describe('vehicleSchema', () => {
  it('accepts a car with nothing optional filled in', () => {
    // The regression. Almost no car has a first-registered date recorded —
    // it exists for hire agreements — so a blank one threw a RangeError and
    // saving *any* vehicle failed.
    expect(() => parse()).not.toThrow();
    expect(() =>
      parse({
        firstRegisteredOn: '',
        valuePence: '',
        purchasePrice: '',
        financePayment: '',
        financeStartsOn: '',
        financeEndsOn: '',
        acquiredOn: '',
        disposedOn: '',
      }),
    ).not.toThrow();
  });

  it('refuses a mistyped amount rather than throwing on it', () => {
    // A refusal becomes a message under the box. A throw becomes "this page
    // could not be loaded", and the operator has no idea which field it was.
    //
    // "750 per month" is the shape somebody actually types into a payment
    // box — and `parseMoney` strips the letters and reads it as £750, which
    // is right, so the case that has to be caught is one with no number the
    // parser can settle on.
    for (const field of ['valuePence', 'purchasePrice', 'financePayment']) {
      const result = vehicleSchema.safeParse({ ...MINIMAL, [field]: '12.3.4' });
      expect(result.success, `${field} should refuse a mistyped amount`).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual([field]);
      }
    }
  });

  it('refuses a mistyped date rather than throwing on it', () => {
    const result = vehicleSchema.safeParse({
      ...MINIMAL,
      firstRegisteredOn: '8th July',
    });
    expect(result.success).toBe(false);
  });

  it('reads an amount however it was typed', () => {
    expect(parse({ financePayment: '£1,250.00' }).financePayment).toBe('£1,250.00');
    // The schema keeps the text; `parseMoney` converts it on the way to the
    // database. What matters here is that neither form is rejected.
    expect(vehicleSchema.safeParse({ ...MINIMAL, purchasePrice: '34500' }).success).toBe(
      true,
    );
  });

  it('defaults an unstated ownership to the driver’s own car', () => {
    // Most of the fleet belongs to its driver. Defaulting the other way would
    // silently make every imported car the company's, and with it every
    // repair bill.
    expect(parse().ownership).toBe('DRIVER_OWNED');
  });
});

describe('financeCostKind', () => {
  it('matches the payment to how the car is held', () => {
    expect(financeCostKind('FINANCED')).toBe('FINANCE');
    expect(financeCostKind('LEASED')).toBe('LEASE');
  });

  it('has no payment for a car nobody is paying instalments on', () => {
    // A car bought outright costs its purchase price once, not a payment a
    // month, and a driver's own car costs the company nothing at all.
    expect(financeCostKind('OWNED')).toBeNull();
    expect(financeCostKind('DRIVER_OWNED')).toBeNull();
  });
});
