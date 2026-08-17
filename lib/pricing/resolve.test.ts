import { describe, expect, it } from 'vitest';
import {
  driverPayFromRule,
  priceFromRule,
  resolveRule,
  ruleApplies,
  ruleProblems,
  specificity,
  type RateQuery,
  type RateRule,
} from './resolve';

/**
 * Rate resolution decides the number an operator sees, and they have no way
 * to tell which of eleven overlapping rules produced it. So "most specific
 * wins" has to be exactly true: the cases here are the ones where a plausible
 * ordering bug would quietly price a Heathrow run at the catch-all rate and
 * nobody would notice until the month's margin came out wrong.
 */

function rule(overrides: Partial<RateRule> = {}): RateRule {
  return {
    id: 'rule-1',
    jobType: 'TRANSFER',
    vehicleClass: null,
    fromZoneId: null,
    toZoneId: null,
    baseFarePence: 10000,
    perHourPence: 0,
    minimumHours: null,
    perDayPence: 0,
    minimumDays: null,
    freeWaitMinutes: 15,
    waitPerMinutePence: 50,
    driverBasePence: 0,
    driverPerHourPence: 0,
    driverPctOfFare: null,
    priority: 0,
    ...overrides,
  };
}

const HEATHROW = 'zone-heathrow';
const CENTRAL = 'zone-central';

function query(overrides: Partial<RateQuery> = {}): RateQuery {
  return {
    jobType: 'TRANSFER',
    vehicleClass: 'EXECUTIVE',
    fromZoneId: HEATHROW,
    toZoneId: CENTRAL,
    ...overrides,
  };
}

describe('ruleApplies', () => {
  it('matches a rule that names neither zone', () => {
    // The catch-all applies anywhere. A rule with no zones that matched
    // nothing would make every rate card empty in practice.
    expect(ruleApplies(rule(), query())).toBe(true);
  });

  it('matches a rule naming the right zones', () => {
    expect(
      ruleApplies(rule({ fromZoneId: HEATHROW, toZoneId: CENTRAL }), query()),
    ).toBe(true);
  });

  it('refuses a rule naming the wrong zone', () => {
    expect(ruleApplies(rule({ fromZoneId: CENTRAL }), query())).toBe(false);
    expect(ruleApplies(rule({ toZoneId: HEATHROW }), query())).toBe(false);
  });

  it('refuses a rule for another job type', () => {
    expect(ruleApplies(rule({ jobType: 'AS_DIRECTED' }), query())).toBe(false);
  });

  it('matches on vehicle class only when the rule names one', () => {
    expect(ruleApplies(rule({ vehicleClass: 'EXECUTIVE' }), query())).toBe(true);
    expect(ruleApplies(rule({ vehicleClass: 'SALOON' }), query())).toBe(false);
    expect(ruleApplies(rule({ vehicleClass: null }), query())).toBe(true);
  });

  it('does not match a zone-specific rule when the job has no zone', () => {
    // An unresolved pickup must fall to the catch-all, not to a rule about a
    // journey nobody established this is.
    expect(
      ruleApplies(rule({ fromZoneId: HEATHROW }), query({ fromZoneId: null })),
    ).toBe(false);
  });
});

describe('specificity ordering', () => {
  it('ranks both zones above one zone above neither', () => {
    // Spec 4.2.4, stated directly.
    const both = rule({ id: 'both', fromZoneId: HEATHROW, toZoneId: CENTRAL });
    const one = rule({ id: 'one', fromZoneId: HEATHROW });
    const neither = rule({ id: 'neither' });

    expect(specificity(both)).toBeGreaterThan(specificity(one));
    expect(specificity(one)).toBeGreaterThan(specificity(neither));
  });

  it('picks the exact zone pair out of a pile of overlapping rules', () => {
    const chosen = resolveRule(
      [
        rule({ id: 'catch-all', baseFarePence: 5000 }),
        rule({ id: 'from-only', fromZoneId: HEATHROW, baseFarePence: 8000 }),
        rule({ id: 'to-only', toZoneId: CENTRAL, baseFarePence: 9000 }),
        rule({
          id: 'exact',
          fromZoneId: HEATHROW,
          toZoneId: CENTRAL,
          baseFarePence: 12000,
        }),
      ],
      query(),
    );

    expect(chosen?.id).toBe('exact');
  });

  it('weighs a zone above a vehicle class', () => {
    // A rule about executive cars anywhere is a weaker claim about a Heathrow
    // run than a Heathrow rule that says nothing about the car.
    const chosen = resolveRule(
      [
        rule({ id: 'class-only', vehicleClass: 'EXECUTIVE' }),
        rule({ id: 'zone-only', fromZoneId: HEATHROW }),
      ],
      query(),
    );
    expect(chosen?.id).toBe('zone-only');
  });

  it('uses the class to refine within the same zone specificity', () => {
    const chosen = resolveRule(
      [
        rule({ id: 'zone', fromZoneId: HEATHROW }),
        rule({ id: 'zone-and-class', fromZoneId: HEATHROW, vehicleClass: 'EXECUTIVE' }),
      ],
      query(),
    );
    expect(chosen?.id).toBe('zone-and-class');
  });

  it('breaks a tie on priority', () => {
    const chosen = resolveRule(
      [
        rule({ id: 'low', fromZoneId: HEATHROW, priority: 1 }),
        rule({ id: 'high', fromZoneId: HEATHROW, priority: 10 }),
      ],
      query(),
    );
    expect(chosen?.id).toBe('high');
  });

  it('is deterministic when specificity and priority both tie', () => {
    // Otherwise the same booking could price differently on two days, which
    // is impossible to explain to a client.
    const rules = [
      rule({ id: 'bbb', fromZoneId: HEATHROW }),
      rule({ id: 'aaa', fromZoneId: HEATHROW }),
    ];
    expect(resolveRule(rules, query())?.id).toBe('aaa');
    expect(resolveRule([...rules].reverse(), query())?.id).toBe('aaa');
  });

  it('returns null when nothing matches', () => {
    // A first-class answer, not a failure — most bookings never match.
    expect(resolveRule([], query())).toBeNull();
    expect(
      resolveRule([rule({ jobType: 'AS_DIRECTED' })], query()),
    ).toBeNull();
  });
});

describe('priceFromRule', () => {
  it('prices a fixed-fare transfer at the base fare', () => {
    const priced = priceFromRule(rule({ baseFarePence: 12500 }), query());
    expect(priced.clientPricePence).toBe(12500);
    expect(priced.explanation).toContain('base fare');
  });

  it('multiplies out hourly work', () => {
    const priced = priceFromRule(
      rule({ jobType: 'AS_DIRECTED', baseFarePence: 0, perHourPence: 6500 }),
      query({ jobType: 'AS_DIRECTED', hours: 4 }),
    );
    expect(priced.clientPricePence).toBe(26000);
    expect(priced.explanation).toContain('4 hours');
  });

  it('floors hourly work at the minimum, and says it did', () => {
    // Booking two hours against a four-hour minimum charges four. An
    // unexplained figure here is one the operator will override away.
    const priced = priceFromRule(
      rule({
        jobType: 'AS_DIRECTED',
        baseFarePence: 0,
        perHourPence: 6500,
        minimumHours: 4,
      }),
      query({ jobType: 'AS_DIRECTED', hours: 2 }),
    );
    expect(priced.clientPricePence).toBe(26000);
    expect(priced.explanation).toContain('minimum');
  });

  it('adds waiting beyond the free allowance, not all of it', () => {
    // 60 minutes waited, 45 free, 15 billable at 50p.
    const priced = priceFromRule(
      rule({ baseFarePence: 10000, freeWaitMinutes: 45, waitPerMinutePence: 50 }),
      query({ waitMinutes: 60 }),
    );
    expect(priced.clientPricePence).toBe(10750);
    expect(priced.explanation).toContain('45 free');
  });

  it('charges nothing for waiting inside the allowance', () => {
    const priced = priceFromRule(
      rule({ baseFarePence: 10000, freeWaitMinutes: 45 }),
      query({ waitMinutes: 30 }),
    );
    expect(priced.clientPricePence).toBe(10000);
  });

  it('rounds once, so hours times a rate never lands off by a penny', () => {
    const priced = priceFromRule(
      rule({ jobType: 'AS_DIRECTED', baseFarePence: 0, perHourPence: 3333 }),
      query({ jobType: 'AS_DIRECTED', hours: 1.5 }),
    );
    expect(priced.clientPricePence).toBe(5000);
    expect(Number.isInteger(priced.clientPricePence)).toBe(true);
  });
});

describe('driver pay', () => {
  it('takes a percentage of the fare when the rule says so', () => {
    const priced = priceFromRule(
      rule({ baseFarePence: 10000, driverPctOfFare: 60 }),
      query(),
    );
    expect(priced.driverPricePence).toBe(6000);
  });

  it('takes fixed amounts when the rule says so', () => {
    const priced = priceFromRule(
      rule({
        jobType: 'AS_DIRECTED',
        baseFarePence: 0,
        perHourPence: 6500,
        driverPerHourPence: 4000,
      }),
      query({ jobType: 'AS_DIRECTED', hours: 3 }),
    );
    expect(priced.driverPricePence).toBe(12000);
  });

  it('is null when the rule says nothing about driver pay', () => {
    // Not zero. Zero would look like a decision to pay nothing.
    expect(priceFromRule(rule(), query()).driverPricePence).toBeNull();
  });

  it('never adds a percentage to a fixed amount', () => {
    // Validation rejects a rule setting both; if one slips through the
    // percentage wins rather than the two being summed.
    const paid = driverPayFromRule(
      rule({ driverPctOfFare: 60, driverBasePence: 5000 }),
      query(),
      10000,
    );
    expect(paid).toBe(6000);
  });

  it('applies the minimum hours to driver pay too', () => {
    // Otherwise the client is charged four hours and the driver paid two.
    const priced = priceFromRule(
      rule({
        jobType: 'AS_DIRECTED',
        baseFarePence: 0,
        perHourPence: 6500,
        minimumHours: 4,
        driverPerHourPence: 4000,
      }),
      query({ jobType: 'AS_DIRECTED', hours: 2 }),
    );
    expect(priced.driverPricePence).toBe(16000);
  });
});

describe('ruleProblems', () => {
  it('rejects a rule paying both a percentage and a fixed amount', () => {
    // Spec 4.2.5. The mistake is only noticed at the end of the month.
    const problems = ruleProblems({
      driverPctOfFare: 60,
      driverBasePence: 5000,
      baseFarePence: 10000,
    });
    expect(problems[0]).toMatch(/never both/);
  });

  it('rejects a percentage outside nought to a hundred', () => {
    expect(
      ruleProblems({ driverPctOfFare: 150, baseFarePence: 10000 }),
    ).toContainEqual(expect.stringMatching(/between 0 and 100/));
  });

  it('rejects a rule that prices everything at nothing', () => {
    expect(
      ruleProblems({ baseFarePence: 0, perHourPence: 0 }),
    ).toContainEqual(expect.stringMatching(/prices every matching job at nothing/));
  });

  it('rejects a minimum with no hourly rate to apply it to', () => {
    expect(
      ruleProblems({ baseFarePence: 10000, perHourPence: 0, minimumHours: 4 }),
    ).toContainEqual(expect.stringMatching(/minimum number of hours/));
  });

  it('passes a sensible rule', () => {
    expect(
      ruleProblems({
        baseFarePence: 12000,
        perHourPence: 0,
        driverPctOfFare: 60,
      }),
    ).toEqual([]);
  });
});
