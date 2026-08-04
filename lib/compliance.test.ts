import { describe, expect, it } from 'vitest';
import {
  classifyExpiry,
  combinedComplianceAt,
  DEFAULT_THRESHOLDS,
  driverComplianceAt,
  vehicleComplianceAt,
  worstLevel,
} from './compliance';
import { fromDateOnlyString } from './dates';

const on = (iso: string) => fromDateOnlyString(iso);
const at = (iso: string) => new Date(iso);

describe('classifyExpiry', () => {
  it('is ok when the date is comfortably ahead', () => {
    expect(classifyExpiry(on('2026-12-31'), at('2026-08-02T12:00:00Z'))).toEqual({
      level: 'ok',
      daysRemaining: 151,
    });
  });

  it('warns inside 30 days', () => {
    const result = classifyExpiry(on('2026-08-25'), at('2026-08-02T12:00:00Z'));
    expect(result.level).toBe('warning');
    expect(result.daysRemaining).toBe(23);
  });

  it('escalates to critical inside 7 days', () => {
    const result = classifyExpiry(on('2026-08-06'), at('2026-08-02T12:00:00Z'));
    expect(result.level).toBe('critical');
    expect(result.daysRemaining).toBe(4);
  });

  it('reports an expired document with negative days', () => {
    const result = classifyExpiry(on('2026-07-14'), at('2026-08-02T12:00:00Z'));
    expect(result.level).toBe('expired');
    expect(result.daysRemaining).toBe(-19);
  });

  it('treats a missing date as unknown, never as valid', () => {
    // The legacy system's defining assumption, and the one this replaces.
    expect(classifyExpiry(null, at('2026-08-02T12:00:00Z'))).toEqual({
      level: 'unknown',
      daysRemaining: null,
    });
    expect(classifyExpiry(undefined, at('2026-08-02T12:00:00Z')).level).toBe(
      'unknown',
    );
  });

  describe('the expiry date itself is inclusive', () => {
    // A PHV badge expiring 14 July is valid all of 14 July, London time.
    // BST means local midnight is 23:00 UTC the previous day.
    const expiry = on('2026-07-14');

    it('is still valid at the last moment of the expiry day', () => {
      // 23:59:59 BST on the 14th.
      expect(classifyExpiry(expiry, at('2026-07-14T22:59:59Z')).level).toBe(
        'critical',
      );
    });

    it('is expired at the first moment of the next day', () => {
      // 00:00:00 BST on the 15th.
      expect(classifyExpiry(expiry, at('2026-07-14T23:00:00Z')).level).toBe(
        'expired',
      );
    });

    it('is valid at the start of the expiry day', () => {
      expect(classifyExpiry(expiry, at('2026-07-13T23:00:00Z')).level).toBe(
        'critical',
      );
    });
  });

  it('handles a winter expiry, where local midnight is UTC midnight', () => {
    const expiry = on('2026-01-31');
    expect(classifyExpiry(expiry, at('2026-01-31T23:59:59Z')).level).not.toBe(
      'expired',
    );
    expect(classifyExpiry(expiry, at('2026-02-01T00:00:00Z')).level).toBe(
      'expired',
    );
  });

  it('honours configured thresholds', () => {
    const relaxed = { warningDays: 60, criticalDays: 14 };
    expect(
      classifyExpiry(on('2026-09-20'), at('2026-08-02T12:00:00Z'), relaxed).level,
    ).toBe('warning');
    expect(
      classifyExpiry(on('2026-08-12'), at('2026-08-02T12:00:00Z'), relaxed).level,
    ).toBe('critical');
  });

  it('classifies against a future moment, not just now', () => {
    // The assignment case, and the reason `at` is a parameter: a badge that
    // is merely expiring today is expired by the time of a pickup next week.
    const expiry = on('2026-08-10');
    expect(classifyExpiry(expiry, at('2026-08-02T12:00:00Z')).level).toBe(
      'warning',
    );
    expect(classifyExpiry(expiry, at('2026-08-20T12:00:00Z')).level).toBe(
      'expired',
    );
  });

  it('draws the critical boundary at exactly the threshold', () => {
    const from = at('2026-08-02T12:00:00Z');
    // 7 days out is critical; 8 is only a warning.
    expect(classifyExpiry(on('2026-08-09'), from).level).toBe('critical');
    expect(classifyExpiry(on('2026-08-10'), from).level).toBe('warning');
    // 30 days out is a warning; 31 is fine.
    expect(classifyExpiry(on('2026-09-01'), from).level).toBe('warning');
    expect(classifyExpiry(on('2026-09-02'), from).level).toBe('ok');
  });
});

describe('worstLevel', () => {
  it('ranks expired above everything', () => {
    expect(worstLevel(['ok', 'warning', 'expired', 'critical'])).toBe('expired');
  });

  it('ranks unknown above critical — an unknown date could already be lapsed', () => {
    expect(worstLevel(['critical', 'unknown', 'ok'])).toBe('unknown');
  });

  it('returns ok for an empty list', () => {
    expect(worstLevel([])).toBe('ok');
  });
});

describe('driverComplianceAt', () => {
  const now = at('2026-08-02T12:00:00Z');

  it('passes a driver with both documents in date', () => {
    const result = driverComplianceAt(
      { dvlaLicenceExpiry: on('2027-01-01'), phvBadgeExpiry: on('2027-06-30') },
      now,
    );
    expect(result.compliant).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.level).toBe('ok');
  });

  it('fails on a lapsed PHV badge and says so specifically', () => {
    const result = driverComplianceAt(
      { dvlaLicenceExpiry: on('2027-01-01'), phvBadgeExpiry: on('2026-07-14') },
      now,
    );
    expect(result.compliant).toBe(false);
    expect(result.reasons).toEqual(['PHV badge expired 19 days ago']);
    expect(result.level).toBe('expired');
  });

  it('fails on a missing expiry date', () => {
    const result = driverComplianceAt(
      { dvlaLicenceExpiry: null, phvBadgeExpiry: on('2027-06-30') },
      now,
    );
    expect(result.compliant).toBe(false);
    expect(result.reasons).toEqual([
      'DVLA licence has no expiry date recorded',
    ]);
  });

  it('reports every problem, not just the first', () => {
    const result = driverComplianceAt(
      { dvlaLicenceExpiry: null, phvBadgeExpiry: on('2026-07-14') },
      now,
    );
    expect(result.reasons).toHaveLength(2);
  });

  it('stays compliant while merely expiring soon', () => {
    // Warning is a nudge, not a block. Refusing work a fortnight early would
    // ground drivers who are mid-renewal.
    const result = driverComplianceAt(
      { dvlaLicenceExpiry: on('2027-01-01'), phvBadgeExpiry: on('2026-08-06') },
      now,
    );
    expect(result.compliant).toBe(true);
    expect(result.level).toBe('critical');
  });
});

describe('vehicleComplianceAt', () => {
  const now = at('2026-08-02T12:00:00Z');
  const valid = {
    motExpiry: on('2027-03-01'),
    insuranceExpiry: on('2027-01-01'),
    phvLicenceExpiry: on('2027-02-01'),
  };

  it('passes a vehicle with all three in date', () => {
    expect(vehicleComplianceAt(valid, now).compliant).toBe(true);
  });

  it('fails on a lapsed MOT', () => {
    const result = vehicleComplianceAt(
      { ...valid, motExpiry: on('2026-06-30') },
      now,
    );
    expect(result.compliant).toBe(false);
    expect(result.reasons[0]).toContain('MOT expired');
  });

  it('fails on lapsed insurance', () => {
    const result = vehicleComplianceAt(
      { ...valid, insuranceExpiry: on('2026-08-01') },
      now,
    );
    expect(result.compliant).toBe(false);
    expect(result.reasons[0]).toContain('Insurance expired');
  });

  it('fails when the PHV vehicle licence has no date', () => {
    const result = vehicleComplianceAt(
      { ...valid, phvLicenceExpiry: null },
      now,
    );
    expect(result.compliant).toBe(false);
    expect(result.reasons[0]).toContain('no expiry date recorded');
  });
});

describe('combinedComplianceAt', () => {
  const now = at('2026-08-02T12:00:00Z');
  const goodDriver = {
    dvlaLicenceExpiry: on('2027-01-01'),
    phvBadgeExpiry: on('2027-06-30'),
  };
  const goodVehicle = {
    registration: 'KR22 RRZ',
    motExpiry: on('2027-03-01'),
    insuranceExpiry: on('2027-01-01'),
    phvLicenceExpiry: on('2027-02-01'),
  };

  it('passes when both are in order', () => {
    expect(combinedComplianceAt(goodDriver, goodVehicle, now).compliant).toBe(
      true,
    );
  });

  it('fails a compliant driver in a non-compliant vehicle', () => {
    // The reason the driver list spans both: a valid badge in an uninsured
    // car is still not a job that can go out.
    const result = combinedComplianceAt(
      goodDriver,
      { ...goodVehicle, insuranceExpiry: on('2026-07-01') },
      now,
    );
    expect(result.compliant).toBe(false);
    expect(result.reasons[0]).toContain('KR22 RRZ:');
    expect(result.reasons[0]).toContain('Insurance expired');
  });

  it('names the vehicle so the operator knows which car to chase', () => {
    const result = combinedComplianceAt(
      goodDriver,
      { ...goodVehicle, motExpiry: null },
      now,
    );
    expect(result.reasons[0]).toBe(
      'KR22 RRZ: MOT has no expiry date recorded',
    );
  });

  it('falls back to the driver alone when no vehicle is assigned', () => {
    const result = combinedComplianceAt(goodDriver, null, now);
    expect(result.compliant).toBe(true);
    expect(result.items).toHaveLength(2);
  });

  it('combines the items from both', () => {
    expect(combinedComplianceAt(goodDriver, goodVehicle, now).items).toHaveLength(
      5,
    );
  });

  it('reports the worst level across both', () => {
    const result = combinedComplianceAt(
      goodDriver,
      { ...goodVehicle, motExpiry: on('2026-08-05') },
      now,
    );
    expect(result.level).toBe('critical');
  });
});

describe('default thresholds', () => {
  it('are the 30 and 7 days the spec calls for', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ warningDays: 30, criticalDays: 7 });
  });
});
