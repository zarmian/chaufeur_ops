import { rawPrismaClient } from '../raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cardForQuery,
  clearUnmatched,
  suggestPrice,
  unmatchedPickups,
} from './rate-card';

/**
 * Rate resolution against real rows.
 *
 * The matching order is unit-tested exhaustively in `./resolve.test.ts`. What
 * only this can prove is the wiring: that free pickup text becomes a zone,
 * that an account's own card beats the default, and that a booking nothing
 * priced is recorded rather than silently ignored — because the list of
 * things the matcher misses is the only signal that pricing is quietly not
 * being used.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-6);
const SCHEDULED = new Date('2026-09-15T14:30:00Z');

describe.skipIf(!DATABASE_AVAILABLE)('rate card resolution', () => {
  let cardId = '';
  let accountCardId = '';
  let accountId = '';
  let heathrowId = '';
  let centralId = '';

  beforeAll(async () => {
    if (!raw) return;

    const heathrow = await raw.zone.findFirstOrThrow({
      where: { name: 'Heathrow' },
    });
    const central = await raw.zone.findFirstOrThrow({
      where: { name: 'Central London' },
    });
    heathrowId = heathrow.id;
    centralId = central.id;

    const card = await raw.rateCard.create({
      data: {
        name: `Test card ${stamp}`,
        activeFrom: new Date('2026-01-01T00:00:00Z'),
        isDefault: false,
      },
    });
    cardId = card.id;

    await raw.rateCardRule.createMany({
      data: [
        // The catch-all for transfers.
        {
          rateCardId: cardId,
          jobType: 'TRANSFER',
          baseFarePence: 6000,
          freeWaitMinutes: 15,
          waitPerMinutePence: 50,
          driverPctOfFare: 60,
        },
        // Anything out of Heathrow.
        {
          rateCardId: cardId,
          jobType: 'TRANSFER',
          fromZoneId: heathrowId,
          baseFarePence: 9000,
          freeWaitMinutes: 45,
          waitPerMinutePence: 50,
          driverPctOfFare: 60,
        },
        // Heathrow to Central specifically.
        {
          rateCardId: cardId,
          jobType: 'TRANSFER',
          fromZoneId: heathrowId,
          toZoneId: centralId,
          baseFarePence: 12500,
          freeWaitMinutes: 45,
          waitPerMinutePence: 50,
          driverPctOfFare: 60,
        },
        // Hourly work.
        {
          rateCardId: cardId,
          jobType: 'AS_DIRECTED',
          baseFarePence: 0,
          perHourPence: 6500,
          minimumHours: 4,
          driverPerHourPence: 4000,
        },
      ],
    });

    // A second card, carried by one account, to prove the override.
    const ownCard = await raw.rateCard.create({
      data: {
        name: `Account card ${stamp}`,
        activeFrom: new Date('2026-01-01T00:00:00Z'),
        isDefault: false,
        rules: {
          create: [
            {
              jobType: 'TRANSFER',
              fromZoneId: heathrowId,
              toZoneId: centralId,
              baseFarePence: 9900,
              freeWaitMinutes: 45,
              driverPctOfFare: 65,
            },
          ],
        },
      },
    });
    accountCardId = ownCard.id;

    const account = await raw.account.create({
      data: {
        name: `Agency ${stamp}`,
        kind: 'AGENCY',
        rateCardId: accountCardId,
      },
    });
    accountId = account.id;
  });

  /** Cards this file took the default flag away from, so it can hand it back. */
  const displacedDefaults = new Set<string>();

  afterAll(async () => {
    if (!raw) return;
    await raw.account.deleteMany({ where: { id: accountId } });
    await raw.rateCardRule.deleteMany({
      where: { rateCardId: { in: [cardId, accountCardId] } },
    });
    await raw.rateCard.deleteMany({
      where: { id: { in: [cardId, accountCardId] } },
    });
    await raw.setting.deleteMany({
      where: { key: { startsWith: 'pricing.unmatched.' } },
    });

    // After this file's own cards are deleted, not before — otherwise the
    // restored default would be demoted again on the way out.
    if (displacedDefaults.size > 0) {
      await raw.rateCard.updateMany({
        where: { id: { in: [...displacedDefaults] } },
        data: { isDefault: true },
      });
    }

    await raw.$disconnect();
  });

  /** The test card is not the default, so it is selected explicitly. */
  async function suggestOnTestCard(
    query: Parameters<typeof suggestPrice>[0],
  ) {
    /*
     * Remember whose default this was, so `afterAll` can give it back.
     *
     * It used to read the displaced cards into `previousDefaults` and then
     * `void` them — the intent was there and the restore was never written.
     * The effect: this file promoted its own card, demoted the seeded one,
     * and then deleted its own card on the way out, leaving the database with
     * **no default rate card at all**. Every later run of the suite then
     * failed in `telegram.integration.test.ts`, which needs one — a failure
     * that looks like a Telegram bug and is nothing of the sort.
     *
     * CI never saw it because CI seeds a fresh database for every run. It
     * only bites the second time anybody runs the suite locally, which is
     * exactly when it is least welcome.
     */
    const displaced = await raw!.rateCard.findMany({
      where: { isDefault: true, id: { not: cardId } },
      select: { id: true },
    });
    for (const card of displaced) displacedDefaults.add(card.id);

    await raw!.rateCard.update({
      where: { id: cardId },
      data: { isDefault: true },
    });
    await raw!.rateCard.updateMany({
      where: { isDefault: true, id: { not: cardId } },
      data: { isDefault: false },
    });
    return suggestPrice(query);
  }

  it('turns free pickup text into a zone and prices the exact pair', async () => {
    // "London Heathrow airport terminal 5" has to reach the Heathrow-to-
    // Central rule, not the catch-all.
    const suggestion = await suggestOnTestCard({
      jobType: 'TRANSFER',
      pickupText: 'London Heathrow airport terminal 5',
      dropoffText: 'The Dorchester, Park Lane, W1K 1QA',
      scheduledAt: SCHEDULED,
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.clientPricePence).toBe(12500);
    expect(suggestion?.fromZoneName).toBe('Heathrow');
    expect(suggestion?.toZoneName).toBe('Central London');
    expect(suggestion?.driverPricePence).toBe(7500);
    expect(suggestion?.explanation).toContain('base fare');
  });

  it('falls to the one-sided rule when the destination is elsewhere', async () => {
    const suggestion = await suggestOnTestCard({
      jobType: 'TRANSFER',
      pickupText: 'Heathrow T3',
      dropoffText: 'Watford, WD17 1AA',
      scheduledAt: SCHEDULED,
    });

    expect(suggestion?.clientPricePence).toBe(9000);
    expect(suggestion?.fromZoneName).toBe('Heathrow');
  });

  it('falls to the catch-all when neither end resolves', async () => {
    const suggestion = await suggestOnTestCard({
      jobType: 'TRANSFER',
      pickupText: 'The usual place',
      dropoffText: 'The other place',
      scheduledAt: SCHEDULED,
    });

    expect(suggestion?.clientPricePence).toBe(6000);
    expect(suggestion?.fromZoneName).toBeNull();
  });

  it('prices hourly work at the minimum when fewer hours are booked', async () => {
    const suggestion = await suggestOnTestCard({
      jobType: 'AS_DIRECTED',
      pickupText: 'The Savoy',
      hours: 2,
      scheduledAt: SCHEDULED,
    });

    expect(suggestion?.clientPricePence).toBe(26000);
    expect(suggestion?.driverPricePence).toBe(16000);
    expect(suggestion?.explanation).toContain('minimum');
  });

  it("prefers an account's own card over the default", async () => {
    // Spec 4.2.9. The same journey, a different agreement.
    const suggestion = await suggestOnTestCard({
      jobType: 'TRANSFER',
      accountId,
      pickupText: 'Heathrow T5',
      dropoffText: 'The Dorchester, W1K 1QA',
      scheduledAt: SCHEDULED,
    });

    expect(suggestion?.clientPricePence).toBe(9900);
    expect(suggestion?.driverPricePence).toBe(6435);
    expect(suggestion?.explanation).toContain('Account card');
  });

  it('picks the card active on the job date, not today', async () => {
    // A booking taken in March for a job in April is priced on April's card.
    const card = await cardForQuery({
      jobType: 'TRANSFER',
      scheduledAt: SCHEDULED,
    });
    expect(card).not.toBeNull();
    expect(card!.activeFrom.getTime()).toBeLessThanOrEqual(SCHEDULED.getTime());
  });

  it('returns null for a job dated before any card starts', async () => {
    const suggestion = await suggestOnTestCard({
      jobType: 'TRANSFER',
      pickupText: 'Heathrow T5',
      scheduledAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(suggestion).toBeNull();
  });

  it('records a pickup nothing priced, so the matcher can be improved', async () => {
    // Spec 4.1.7. Without this the only signal that pricing is not working
    // is an operator quietly typing every price by hand.
    const odd = `Behind the blue gate ${stamp}`;

    await suggestOnTestCard({
      jobType: 'AIRPORT_TRANSFER',
      pickupText: odd,
      dropoffText: 'Gatwick',
      scheduledAt: SCHEDULED,
    });

    const unmatched = await unmatchedPickups();
    expect(unmatched.map((row) => row.pickupText)).toContain(odd);

    // The same text twice does not accumulate rows.
    await suggestOnTestCard({
      jobType: 'AIRPORT_TRANSFER',
      pickupText: odd,
      scheduledAt: SCHEDULED,
    });
    const again = await unmatchedPickups();
    expect(again.filter((row) => row.pickupText === odd)).toHaveLength(1);

    await clearUnmatched(odd);
    const cleared = await unmatchedPickups();
    expect(cleared.map((row) => row.pickupText)).not.toContain(odd);
  });

  it('offers nothing rather than a price of zero', async () => {
    // A rule pricing at nothing is a misconfiguration, not a free job.
    // Suggesting £0.00 is how an unpriced job gets created on purpose.
    const zeroCard = await raw!.rateCard.create({
      data: {
        name: `Zero card ${stamp}`,
        activeFrom: new Date('2026-01-01T00:00:00Z'),
        isDefault: true,
        rules: {
          create: [{ jobType: 'TRANSFER', baseFarePence: 0, perHourPence: 0 }],
        },
      },
    });
    await raw!.rateCard.updateMany({
      where: { isDefault: true, id: { not: zeroCard.id } },
      data: { isDefault: false },
    });

    const suggestion = await suggestPrice({
      jobType: 'TRANSFER',
      pickupText: 'Anywhere',
      scheduledAt: SCHEDULED,
    });
    expect(suggestion).toBeNull();

    await raw!.rateCardRule.deleteMany({ where: { rateCardId: zeroCard.id } });
    await raw!.rateCard.delete({ where: { id: zeroCard.id } });
  });

  it('returns null rather than throwing when there is no card at all', async () => {
    // A booking form that breaks when the rate card is misconfigured is
    // worse than one that simply offers no suggestion.
    await raw!.rateCard.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });

    const suggestion = await suggestPrice({
      jobType: 'TRANSFER',
      pickupText: 'Heathrow T5',
      scheduledAt: SCHEDULED,
    });
    expect(suggestion).toBeNull();
  });
});
