import { describe, expect, it } from 'vitest';
import {
  chargeableEnd,
  chargeablePeriods,
  DEFAULT_CHECKLIST_ITEMS,
  findRentalOverlap,
  fuelDifferencePct,
  mileageDriven,
  occupiesVehicle,
  RATE_TYPE_LABELS,
  rentalBalance,
  rentalCharge,
  vehicleAvailableAt,
} from './rentals';

/**
 * Rental charging decides what a driver owes, and the availability rule
 * decides whether a car can be sent on a job. Both are pinned here.
 */

const at = (iso: string) => new Date(iso);

const base = {
  startAt: at('2026-08-03T09:00:00Z'),
  endAt: at('2026-08-10T09:00:00Z'),
  returnedAt: null as Date | null,
  rateType: 'DAILY' as const,
  ratePence: 8000,
  damageChargePence: 0,
  depositPence: 0,
  depositReturnedPence: 0,
};

describe('chargeablePeriods', () => {
  it('counts whole days for a week-long daily hire', () => {
    expect(
      chargeablePeriods(at('2026-08-03T09:00:00Z'), at('2026-08-10T09:00:00Z'), 'DAILY'),
    ).toBe(7);
  });

  it('rounds up — an extra hour on a daily hire is a second day', () => {
    // Rounding down would hand back revenue on every late return.
    expect(
      chargeablePeriods(at('2026-08-03T09:00:00Z'), at('2026-08-04T10:00:00Z'), 'DAILY'),
    ).toBe(2);
  });

  it('rounds up on hourly hires too', () => {
    expect(
      chargeablePeriods(at('2026-08-03T09:00:00Z'), at('2026-08-03T12:01:00Z'), 'HOURLY'),
    ).toBe(4);
  });

  it('counts weeks', () => {
    expect(
      chargeablePeriods(at('2026-08-03T09:00:00Z'), at('2026-08-17T09:00:00Z'), 'WEEKLY'),
    ).toBe(2);
  });

  it('charges one period for a zero-length or backwards hire', () => {
    // The car still came off the fleet.
    expect(
      chargeablePeriods(at('2026-08-03T09:00:00Z'), at('2026-08-03T09:00:00Z'), 'DAILY'),
    ).toBe(1);
    expect(
      chargeablePeriods(at('2026-08-03T09:00:00Z'), at('2026-08-02T09:00:00Z'), 'DAILY'),
    ).toBe(1);
  });
});

describe('chargeableEnd', () => {
  it('bills to the planned end while the car is still out', () => {
    expect(chargeableEnd({ endAt: base.endAt, returnedAt: null })).toBe(base.endAt);
  });

  it('bills to a late return', () => {
    const late = at('2026-08-12T09:00:00Z');
    expect(chargeableEnd({ endAt: base.endAt, returnedAt: late })).toBe(late);
  });

  it('bills to an early return, not the planned end', () => {
    // A car brought back on Tuesday does not bill to Friday.
    const early = at('2026-08-05T09:00:00Z');
    expect(chargeableEnd({ endAt: base.endAt, returnedAt: early })).toBe(early);
  });
});

describe('rentalCharge', () => {
  it('multiplies periods by the rate', () => {
    const charge = rentalCharge(base);
    expect(charge.periods).toBe(7);
    expect(charge.rentalPence).toBe(56000);
    expect(charge.totalPence).toBe(56000);
  });

  it('charges the extra days on a late return', () => {
    const charge = rentalCharge({
      ...base,
      returnedAt: at('2026-08-12T11:00:00Z'),
    });
    expect(charge.periods).toBe(10);
    expect(charge.rentalPence).toBe(80000);
  });

  it('credits an early return', () => {
    const charge = rentalCharge({ ...base, returnedAt: at('2026-08-06T09:00:00Z') });
    expect(charge.periods).toBe(3);
    expect(charge.rentalPence).toBe(24000);
  });

  it('adds damage on top rather than folding it into the rate', () => {
    // An invoice that hides damage inside the daily rate is uncheckable.
    const charge = rentalCharge({ ...base, damageChargePence: 15000 });
    expect(charge.rentalPence).toBe(56000);
    expect(charge.damageChargePence).toBe(15000);
    expect(charge.totalPence).toBe(71000);
  });

  it('ignores a negative damage charge', () => {
    expect(rentalCharge({ ...base, damageChargePence: -500 }).damageChargePence).toBe(0);
  });
});

describe('rentalBalance', () => {
  it('nets payments off the total', () => {
    const balance = rentalBalance(base, [
      { amountPence: 20000 },
      { amountPence: 16000 },
    ]);
    expect(balance.paidPence).toBe(36000);
    expect(balance.balancePence).toBe(20000);
    expect(balance.inArrears).toBe(true);
  });

  it('is settled when paid in full', () => {
    const balance = rentalBalance(base, [{ amountPence: 56000 }]);
    expect(balance.balancePence).toBe(0);
    expect(balance.inArrears).toBe(false);
  });

  it('shows an overpayment as a negative balance', () => {
    expect(rentalBalance(base, [{ amountPence: 60000 }]).balancePence).toBe(-4000);
  });

  it('does not net the deposit off the hire', () => {
    // The deposit secures the car against damage; it is not a payment toward
    // the rent. Treating it as one is how a hire looks settled when it has
    // only been secured.
    const balance = rentalBalance({ ...base, depositPence: 30000 }, []);
    expect(balance.balancePence).toBe(56000);
    expect(balance.depositHeldPence).toBe(30000);
  });

  it('stops counting a deposit once it has been returned', () => {
    const balance = rentalBalance(
      { ...base, depositPence: 30000, depositReturnedPence: 30000 },
      [],
    );
    expect(balance.depositHeldPence).toBe(0);
  });

  it('handles a partly returned deposit', () => {
    // £100 held back against damage.
    const balance = rentalBalance(
      { ...base, depositPence: 30000, depositReturnedPence: 20000 },
      [],
    );
    expect(balance.depositHeldPence).toBe(10000);
  });

  it('treats a rental with no payments as wholly in arrears', () => {
    const balance = rentalBalance(base, []);
    expect(balance.paidPence).toBe(0);
    expect(balance.balancePence).toBe(56000);
  });
});

describe('occupiesVehicle', () => {
  const rental = {
    startAt: at('2026-08-03T09:00:00Z'),
    endAt: at('2026-08-10T09:00:00Z'),
    returnedAt: null as Date | null,
    status: 'ACTIVE' as const,
  };

  it('occupies the car through the hire', () => {
    expect(occupiesVehicle(rental, at('2026-08-05T12:00:00Z'))).toBe(true);
  });

  it('does not occupy it before or after', () => {
    expect(occupiesVehicle(rental, at('2026-08-01T12:00:00Z'))).toBe(false);
    expect(occupiesVehicle(rental, at('2026-08-12T12:00:00Z'))).toBe(false);
  });

  it('frees the car from the moment it comes back early', () => {
    const returned = { ...rental, returnedAt: at('2026-08-05T09:00:00Z') };
    expect(occupiesVehicle(returned, at('2026-08-07T12:00:00Z'))).toBe(false);
    expect(occupiesVehicle(returned, at('2026-08-04T12:00:00Z'))).toBe(true);
  });

  it('never occupies the car when cancelled', () => {
    expect(
      occupiesVehicle({ ...rental, status: 'CANCELLED' }, at('2026-08-05T12:00:00Z')),
    ).toBe(false);
  });

  it('occupies it for a booked rental that has not started yet', () => {
    // The car is spoken for; sending it on a job would double-book it.
    expect(
      occupiesVehicle({ ...rental, status: 'BOOKED' }, at('2026-08-05T12:00:00Z')),
    ).toBe(true);
  });
});

describe('vehicleAvailableAt', () => {
  const rentals = [
    {
      reference: 'RNT-000042',
      startAt: at('2026-08-03T09:00:00Z'),
      endAt: at('2026-08-10T09:00:00Z'),
      returnedAt: null,
      status: 'ACTIVE' as const,
    },
  ];

  it('refuses a car that is out, and names the rental', () => {
    // Refused the same way a lapsed MOT is, but recoverable by talking to the
    // renter — so the message has to say which rental.
    const result = vehicleAvailableAt(rentals, at('2026-08-05T12:00:00Z'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('RNT-000042');
      expect(result.rentalReference).toBe('RNT-000042');
    }
  });

  it('allows a car that is back', () => {
    expect(vehicleAvailableAt(rentals, at('2026-08-11T12:00:00Z'))).toEqual({ ok: true });
  });

  it('allows a car with no rentals at all', () => {
    expect(vehicleAvailableAt([], at('2026-08-05T12:00:00Z'))).toEqual({ ok: true });
  });
});

describe('findRentalOverlap', () => {
  const existing = [
    {
      id: 'r1',
      reference: 'RNT-000042',
      startAt: at('2026-08-03T09:00:00Z'),
      endAt: at('2026-08-10T09:00:00Z'),
      returnedAt: null,
      status: 'ACTIVE' as const,
    },
  ];

  it('rejects a hire that overlaps an existing one', () => {
    expect(
      findRentalOverlap(
        { startAt: at('2026-08-08T09:00:00Z'), endAt: at('2026-08-15T09:00:00Z') },
        existing,
      )?.reference,
    ).toBe('RNT-000042');
  });

  it('accepts a hire that starts after the last one ends', () => {
    expect(
      findRentalOverlap(
        { startAt: at('2026-08-11T09:00:00Z'), endAt: at('2026-08-18T09:00:00Z') },
        existing,
      ),
    ).toBeNull();
  });

  it('ignores the rental being edited', () => {
    expect(
      findRentalOverlap(
        { id: 'r1', startAt: at('2026-08-03T09:00:00Z'), endAt: at('2026-08-10T09:00:00Z') },
        existing,
      ),
    ).toBeNull();
  });
});

describe('handover readings', () => {
  it('reports fuel returned lower as a negative difference', () => {
    expect(fuelDifferencePct(100, 25)).toBe(-75);
  });

  it('reports fuel returned fuller as positive', () => {
    expect(fuelDifferencePct(50, 75)).toBe(25);
  });

  it('is null when either reading is missing', () => {
    expect(fuelDifferencePct(null, 25)).toBeNull();
    expect(fuelDifferencePct(100, null)).toBeNull();
  });

  it('computes miles driven', () => {
    expect(mileageDriven(41200, 42350)).toBe(1150);
  });

  it('treats a backwards odometer as a typo, not negative mileage', () => {
    expect(mileageDriven(42350, 41200)).toBe(0);
  });

  it('is null when either reading is missing', () => {
    expect(mileageDriven(null, 42350)).toBeNull();
  });
});

describe('checklist and labels', () => {
  it('ships a default handover checklist', () => {
    expect(DEFAULT_CHECKLIST_ITEMS.length).toBeGreaterThan(5);
    expect(DEFAULT_CHECKLIST_ITEMS.join(' ')).toMatch(/tyres/i);
  });

  it('labels every rate type', () => {
    expect(RATE_TYPE_LABELS.HOURLY).toBeTruthy();
    expect(RATE_TYPE_LABELS.DAILY).toBeTruthy();
    expect(RATE_TYPE_LABELS.WEEKLY).toBeTruthy();
  });
});
