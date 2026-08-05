import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteRateRule,
  noteLocationUse,
  retireRateCard,
  saveRateCard,
  saveRateRule,
  saveZone,
} from './config';

/**
 * Pricing configuration against a real database.
 *
 * The refusals are what only this can prove. A rate card that has priced a
 * job must not be deletable, because `Job.rateCardRuleId` is how a fare is
 * explained months later — and that is a foreign key, not an opinion.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const audit = { userId: null, ip: null };
const stamp = String(Date.now()).slice(-8);

const baseRule = {
  jobType: 'TRANSFER' as const,
  vehicleClass: null,
  fromZoneId: null,
  toZoneId: null,
  baseFare: '85.00',
  perHour: null,
  minimumHours: null,
  freeWaitMinutes: 15,
  waitPerMinute: null,
  driverBase: null,
  driverPerHour: null,
  driverPctOfFare: null,
  priority: 0,
};

describe.skipIf(!DATABASE_AVAILABLE)('pricing configuration', () => {
  const cardIds: string[] = [];
  const zoneIds: string[] = [];
  const locationIds: string[] = [];

  afterAll(async () => {
    if (!raw) return;
    await raw.job.updateMany({
      where: { rateCardRule: { rateCardId: { in: cardIds } } },
      data: { rateCardRuleId: null },
    });
    await raw.rateCardRule.deleteMany({ where: { rateCardId: { in: cardIds } } });
    await raw.rateCard.deleteMany({ where: { id: { in: cardIds } } });
    await raw.location.deleteMany({ where: { id: { in: locationIds } } });
    await raw.zone.deleteMany({ where: { id: { in: zoneIds } } });
    await raw.$disconnect();
  });

  async function makeCard(name: string, isDefault = false) {
    const result = await saveRateCard(
      null,
      {
        name: `${name} ${stamp}`,
        activeFrom: '2026-01-01',
        activeTo: null,
        isDefault: isDefault ? ('on' as const) : ('' as const),
      },
      audit,
    );
    expect(result.ok).toBe(true);
    if (result.ok) cardIds.push(result.id);
    return result.ok ? result.id : '';
  }

  it('keeps exactly one default card', async () => {
    // Two would make "which card prices this job" depend on insertion order,
    // which is not an answer anyone can act on.
    const first = await makeCard('Default A', true);
    const second = await makeCard('Default B', true);

    const a = await raw!.rateCard.findUniqueOrThrow({ where: { id: first } });
    const b = await raw!.rateCard.findUniqueOrThrow({ where: { id: second } });

    expect(a.isDefault).toBe(false);
    expect(b.isDefault).toBe(true);

    const defaults = await raw!.rateCard.count({ where: { isDefault: true } });
    expect(defaults).toBe(1);
  });

  it('refuses a rule that pays the driver twice', async () => {
    const cardId = await makeCard('Double pay');

    const result = await saveRateRule(
      cardId,
      null,
      { ...baseRule, driverBase: '50.00', driverPctOfFare: 70 },
      audit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_RULE');
      expect(result.message).toContain('never both');
    }

    const rules = await raw!.rateCardRule.count({ where: { rateCardId: cardId } });
    expect(rules).toBe(0);
  });

  it('refuses a rule that prices every matching job at nothing', async () => {
    const cardId = await makeCard('Free rides');

    const result = await saveRateRule(
      cardId,
      null,
      { ...baseRule, baseFare: null, perHour: null },
      audit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('at nothing');
  });

  it('stores money as pence and hours as a decimal', async () => {
    const cardId = await makeCard('Hourly');

    const result = await saveRateRule(
      cardId,
      null,
      {
        ...baseRule,
        jobType: 'AS_DIRECTED',
        baseFare: null,
        perHour: '45.50',
        minimumHours: 3.5,
        driverPctOfFare: 70,
      },
      audit,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rule = await raw!.rateCardRule.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(rule.perHourPence).toBe(4550);
    expect(Number(rule.minimumHours)).toBe(3.5);
    expect(Number(rule.driverPctOfFare)).toBe(70);
    expect(rule.driverBasePence).toBe(0);
  });

  it('end-dates a card that priced a job rather than deleting it', async () => {
    // Spec 4.2.10. Deleting it would leave a job whose price nothing explains.
    const cardId = await makeCard('In use');
    const rule = await saveRateRule(cardId, null, baseRule, audit);
    if (!rule.ok) throw new Error('rule not created');

    const job = await raw!.job.findFirst({ select: { id: true } });
    if (!job) return; // No jobs in this database; nothing to attach to.

    const previous = await raw!.job.findUniqueOrThrow({
      where: { id: job.id },
      select: { rateCardRuleId: true },
    });
    await raw!.job.update({
      where: { id: job.id },
      data: { rateCardRuleId: rule.id },
    });

    try {
      const retired = await retireRateCard(cardId, audit);
      expect(retired.ok).toBe(false);
      if (!retired.ok) expect(retired.code).toBe('IN_USE');

      const card = await raw!.rateCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.deletedAt).toBeNull();
      expect(card.activeTo).not.toBeNull();

      // And the rule itself cannot go either, for the same reason.
      const removed = await deleteRateRule(cardId, rule.id, audit);
      expect(removed.ok).toBe(false);
      if (!removed.ok) expect(removed.code).toBe('RULE_IN_USE');
    } finally {
      await raw!.job.update({
        where: { id: job.id },
        data: { rateCardRuleId: previous.rateCardRuleId },
      });
    }
  });

  it('soft-deletes a card nothing has used', async () => {
    const cardId = await makeCard('Never used');

    const retired = await retireRateCard(cardId, audit);
    expect(retired.ok).toBe(true);

    const card = await raw!.rateCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(card.deletedAt).not.toBeNull();
  });

  it('uppercases and de-duplicates postcode prefixes', async () => {
    const result = await saveZone(null, {
      name: `Zone ${stamp}`,
      // Prefixes nothing real claims, so this asserts the tidying rather
      // than colliding with the seeded London zones.
      postcodes: 'zq1, ZQ1\nzq2',
      active: 'on',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    zoneIds.push(result.id);

    const zone = await raw!.zone.findUniqueOrThrow({ where: { id: result.id } });
    expect(zone.postcodes).toEqual(['ZQ1', 'ZQ2']);
  });

  it('refuses a prefix another active zone already claims', async () => {
    // Two zones claiming `ZQ4` would make the match arbitrary: the longest
    // prefix wins and there is nothing left to break the tie, so the same
    // postcode would price differently depending on row order.
    const prefix = `ZQ4`;
    const first = await saveZone(null, {
      name: `Claimant ${stamp}`,
      postcodes: prefix,
      active: 'on',
    });
    expect(first.ok).toBe(true);
    if (first.ok) zoneIds.push(first.id);

    const second = await saveZone(null, {
      name: `Rival ${stamp}`,
      postcodes: `${prefix}, ZQ5`,
      active: 'on',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('PREFIX_CLAIMED');
      expect(second.message).toContain(prefix);
    }

    // Nesting is fine, and deliberate: `ZQ4` and `ZQ40` are the
    // longest-prefix rule working, not a clash.
    const nested = await saveZone(null, {
      name: `Nested ${stamp}`,
      postcodes: `${prefix}0`,
      active: 'on',
    });
    expect(nested.ok).toBe(true);
    if (nested.ok) zoneIds.push(nested.id);
  });

  it('refuses a second zone with the same name', async () => {
    const name = `Duplicate ${stamp}`;
    const first = await saveZone(null, { name, postcodes: '', active: 'on' });
    if (first.ok) zoneIds.push(first.id);

    const second = await saveZone(null, { name, postcodes: '', active: 'on' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('DUPLICATE_ZONE');
  });

  it('counts a location by the text a booking actually carried', async () => {
    // The booking form's pickup is free text backed by a datalist: the
    // browser puts the *label* in the box and no id anywhere. Counting only
    // jobs that carried an id would leave every count at zero forever.
    const location = await raw!.location.create({
      data: { label: `Terminal 5 ${stamp}`, address: `Heathrow ${stamp}` },
    });
    locationIds.push(location.id);

    await noteLocationUse([`terminal 5 ${stamp}`.toUpperCase()]);
    await noteLocationUse([`Heathrow ${stamp}`]);

    const after = await raw!.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    expect(after.useCount).toBe(2);
  });

  it('ignores text that matches nothing saved', async () => {
    await expect(
      noteLocationUse(['Somewhere nobody saved', '', null]),
    ).resolves.toBeUndefined();
  });
});
