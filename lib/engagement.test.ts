import { describe, expect, it } from 'vitest';
import {
  coversMoment,
  DEFAULT_ENGAGEMENT,
  defaultExpenseBearer,
  engagementAt,
  ENGAGEMENT_LABELS,
  findOverlap,
  resolveEngagement,
  type EngagementPeriod,
} from './engagement';

/**
 * Engagement decides what a driver is paid and who pays for the fuel, so the
 * resolution rules get exhaustive coverage. The case that matters most is
 * historic: a job worked in March must still resolve to March's terms after
 * the arrangement changes in June.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function period(overrides: Partial<EngagementPeriod> = {}): EngagementPeriod {
  return {
    id: 'eng_1',
    kind: 'HIRED',
    effectiveFrom: d('2026-01-01'),
    effectiveTo: null,
    hourlyRatePence: 1800,
    dayRatePence: null,
    overtimeAfterMin: null,
    ...overrides,
  };
}

describe('coversMoment', () => {
  it('includes the whole of the start day', () => {
    const p = period({ effectiveFrom: d('2026-03-01') });
    expect(coversMoment(p, new Date('2026-03-01T00:00:00Z'))).toBe(true);
    expect(coversMoment(p, new Date('2026-02-28T23:59:59Z'))).toBe(false);
  });

  it('includes the whole of the end day', () => {
    // An arrangement that ended "on Friday" covers Friday's late job.
    const p = period({ effectiveTo: d('2026-03-31') });
    expect(coversMoment(p, new Date('2026-03-31T23:30:00Z'))).toBe(true);
    expect(coversMoment(p, new Date('2026-04-01T00:00:00Z'))).toBe(false);
  });

  it('treats a null end as still in force', () => {
    expect(coversMoment(period(), new Date('2099-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('engagementAt', () => {
  const march = period({
    id: 'march',
    kind: 'HIRED',
    effectiveFrom: d('2026-03-01'),
    effectiveTo: d('2026-03-31'),
    hourlyRatePence: 1800,
  });
  const june = period({
    id: 'june',
    kind: 'OWNER_DRIVER',
    effectiveFrom: d('2026-06-01'),
    effectiveTo: null,
    hourlyRatePence: null,
  });

  it('finds the arrangement in force at that moment', () => {
    expect(engagementAt([march, june], new Date('2026-03-15T09:00:00Z'))?.id).toBe(
      'march',
    );
    expect(engagementAt([march, june], new Date('2026-07-15T09:00:00Z'))?.id).toBe(
      'june',
    );
  });

  it('returns null in a gap between arrangements', () => {
    expect(engagementAt([march, june], new Date('2026-05-01T09:00:00Z'))).toBeNull();
  });

  it('returns null when the driver has no arrangements at all', () => {
    expect(engagementAt([], new Date())).toBeNull();
  });
});

describe('resolveEngagement', () => {
  const hired = period({
    id: 'hired',
    kind: 'HIRED',
    effectiveFrom: d('2026-01-01'),
    effectiveTo: d('2026-05-31'),
    hourlyRatePence: 1800,
  });
  const owner = period({
    id: 'owner',
    kind: 'OWNER_DRIVER',
    effectiveFrom: d('2026-06-01'),
    effectiveTo: null,
    hourlyRatePence: null,
  });

  it('defaults to owner-driver when nothing is recorded', () => {
    // This is what makes the feature additive: every existing driver keeps
    // behaving exactly as they did in Phase 2.
    const resolved = resolveEngagement(
      { engagementKind: null, scheduledAt: new Date('2026-03-15T09:00:00Z') },
      [],
    );
    expect(resolved.kind).toBe(DEFAULT_ENGAGEMENT);
    expect(resolved.kind).toBe('OWNER_DRIVER');
    expect(resolved.source).toBe('default');
  });

  it('resolves against the job time, not the present', () => {
    // The point of the whole design: a March job keeps March's terms after
    // the driver switches to owner-driver in June.
    const marchJob = resolveEngagement(
      { engagementKind: null, scheduledAt: new Date('2026-03-15T09:00:00Z') },
      [hired, owner],
    );
    expect(marchJob.kind).toBe('HIRED');
    expect(marchJob.hourlyRatePence).toBe(1800);

    const julyJob = resolveEngagement(
      { engagementKind: null, scheduledAt: new Date('2026-07-15T09:00:00Z') },
      [hired, owner],
    );
    expect(julyJob.kind).toBe('OWNER_DRIVER');
  });

  it('lets a job override the arrangement for itself alone', () => {
    const resolved = resolveEngagement(
      {
        engagementKind: 'OWNER_DRIVER',
        scheduledAt: new Date('2026-03-15T09:00:00Z'),
      },
      [hired, owner],
    );
    expect(resolved.kind).toBe('OWNER_DRIVER');
    expect(resolved.source).toBe('job-override');
  });

  it('does not lend an unrelated arrangement’s rate to an override', () => {
    // Overriding to OWNER_DRIVER during a HIRED period must not carry the
    // hourly rate across — the override says the terms were different.
    const resolved = resolveEngagement(
      {
        engagementKind: 'OWNER_DRIVER',
        scheduledAt: new Date('2026-03-15T09:00:00Z'),
      },
      [hired],
    );
    expect(resolved.hourlyRatePence).toBeNull();
  });

  it('keeps the rate when the override agrees with the arrangement', () => {
    const resolved = resolveEngagement(
      { engagementKind: 'HIRED', scheduledAt: new Date('2026-03-15T09:00:00Z') },
      [hired],
    );
    expect(resolved.hourlyRatePence).toBe(1800);
  });

  it('falls back to the default in a gap', () => {
    const resolved = resolveEngagement(
      { engagementKind: null, scheduledAt: new Date('2026-05-15T09:00:00Z') },
      [
        period({ id: 'a', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-04-30') }),
        period({ id: 'b', effectiveFrom: d('2026-06-01'), effectiveTo: null }),
      ],
    );
    expect(resolved.source).toBe('default');
    expect(resolved.kind).toBe('OWNER_DRIVER');
  });
});

describe('findOverlap', () => {
  const existing = [
    period({ id: 'a', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-03-31') }),
    period({ id: 'b', effectiveFrom: d('2026-06-01'), effectiveTo: null }),
  ];

  it('accepts a period that sits in the gap', () => {
    expect(
      findOverlap({ effectiveFrom: d('2026-04-01'), effectiveTo: d('2026-05-31') }, existing),
    ).toBeNull();
  });

  it('rejects a period starting inside an existing one', () => {
    // Two answers to "what were they on that day" is a guess about money.
    expect(
      findOverlap({ effectiveFrom: d('2026-02-01'), effectiveTo: null }, existing)?.id,
    ).toBe('a');
  });

  it('rejects a period that swallows an existing one', () => {
    expect(
      findOverlap({ effectiveFrom: d('2025-01-01'), effectiveTo: d('2027-01-01') }, existing),
    ).not.toBeNull();
  });

  it('rejects anything after an open-ended period', () => {
    expect(
      findOverlap({ effectiveFrom: d('2030-01-01'), effectiveTo: null }, existing)?.id,
    ).toBe('b');
  });

  it('rejects a period abutting the last day of another', () => {
    // The end date is inclusive, so starting on the same day overlaps.
    expect(
      findOverlap({ effectiveFrom: d('2026-03-31'), effectiveTo: null }, existing)?.id,
    ).toBe('a');
  });

  it('accepts a period starting the day after another ends', () => {
    expect(
      findOverlap({ effectiveFrom: d('2026-04-01'), effectiveTo: d('2026-04-30') }, existing),
    ).toBeNull();
  });

  it('ignores the record being edited', () => {
    expect(
      findOverlap(
        { id: 'a', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-03-31') },
        existing,
      ),
    ).toBeNull();
  });
});

describe('defaultExpenseBearer', () => {
  it('recharges journey charges to the client whoever is driving', () => {
    // The congestion charge was incurred for their journey.
    for (const kind of ['TOLL', 'CONGESTION_CHARGE', 'ULEZ', 'PARKING'] as const) {
      expect(defaultExpenseBearer('OWNER_DRIVER', kind), kind).toBe('CLIENT');
      expect(defaultExpenseBearer('HIRED', kind), kind).toBe('CLIENT');
    }
  });

  it('puts fuel on the company for a hired driver and on the driver otherwise', () => {
    expect(defaultExpenseBearer('HIRED', 'FUEL')).toBe('COMPANY');
    expect(defaultExpenseBearer('OWNER_DRIVER', 'FUEL')).toBe('DRIVER');
  });

  it('follows the same rule for anything uncategorised', () => {
    expect(defaultExpenseBearer('HIRED', 'OTHER')).toBe('COMPANY');
    expect(defaultExpenseBearer('OWNER_DRIVER', 'OTHER')).toBe('DRIVER');
  });
});

describe('labels', () => {
  it('names both kinds', () => {
    expect(ENGAGEMENT_LABELS.OWNER_DRIVER).toBeTruthy();
    expect(ENGAGEMENT_LABELS.HIRED).toBeTruthy();
  });
});
