import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIRPORT_LOCATIONS } from './install';
import { locationCandidates, MIN_USES, saveCandidates } from './location-mining';
import { suggestPlaces } from './places/store';

/**
 * Saved locations — spec 6.4.
 *
 * The three things that need a database: that the airport terminals are
 * actually there after a seed, that a client's favourites come first, and
 * that the candidate query counts what people typed rather than what is
 * already saved.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const stamp = String(Date.now()).slice(-7);

describe.skipIf(!DATABASE_AVAILABLE)('saved locations', () => {
  const locationIds: string[] = [];
  const jobIds: string[] = [];
  let clientId = '';

  afterAll(async () => {
    if (!raw) return;
    await raw.clientFavouriteLocation.deleteMany({ where: { clientId } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.location.deleteMany({ where: { id: { in: locationIds } } });
    await raw.client.deleteMany({ where: { id: clientId } });
    await raw.$disconnect();
  });

  describe('airport terminals', () => {
    it('seeds every terminal the spec names', async () => {
      // Spec 6.4.5. These are the addresses that matter most and the ones
      // most often typed differently by different people.
      const labels = AIRPORT_LOCATIONS.map((airport) => airport.label);

      for (const terminal of [
        'Heathrow Terminal 2',
        'Heathrow Terminal 3',
        'Heathrow Terminal 4',
        'Heathrow Terminal 5',
        'Gatwick North Terminal',
        'Gatwick South Terminal',
        'Luton Airport',
        'Stansted Airport',
        'London City Airport',
      ]) {
        expect(labels, `${terminal} is not seeded`).toContain(terminal);
      }
    });

    it('marks them as airports, which is what drives the wait allowance', async () => {
      // The free wait allowance is longer for an airport arrival. A terminal
      // saved without the flag bills the shorter one.
      const saved = await raw!.location.findMany({
        where: { label: { in: AIRPORT_LOCATIONS.map((a) => a.label) } },
      });

      expect(saved.length).toBeGreaterThan(0);
      expect(saved.every((location) => location.isAirport)).toBe(true);
    });

    it('gives them a postcode, so zone resolution needs no lookup', async () => {
      for (const airport of AIRPORT_LOCATIONS) {
        expect(airport.postcode, `${airport.label} has no postcode`).toMatch(
          /^[A-Z]{1,2}\d/,
        );
      }
    });
  });

  describe('a client’s favourites', () => {
    beforeAll(async () => {
      if (!raw) return;

      const client = await raw.client.create({
        data: { name: `Fav Client ${stamp}`, normalisedName: `favclient${stamp}` },
      });
      clientId = client.id;

      // A popular one, and an unpopular one this client always uses. Without
      // the favourite, the popular one wins on `useCount` every time.
      const popular = await raw.location.create({
        data: {
          label: `Popular Tower ${stamp}`,
          address: `Popular Tower ${stamp}, London`,
          useCount: 500,
        },
      });
      const theirs = await raw.location.create({
        data: {
          label: `Popular Annexe ${stamp}`,
          address: `Popular Annexe ${stamp}, London`,
          useCount: 1,
        },
      });
      locationIds.push(popular.id, theirs.id);

      await raw.clientFavouriteLocation.create({
        data: { clientId, locationId: theirs.id },
      });
    });

    it('puts them ahead of a far more popular location', async () => {
      // Spec 6.4.6. Their office will never out-rank Heathrow on a count
      // taken across the whole business.
      const { suggestions } = await suggestPlaces(`Popular`, {
        clientId,
        limit: 8,
      });

      const labels = suggestions.map((suggestion) => suggestion.primary);
      const theirs = labels.indexOf(`Popular Annexe ${stamp}`);
      const popular = labels.indexOf(`Popular Tower ${stamp}`);

      expect(theirs, 'the favourite is not offered at all').toBeGreaterThanOrEqual(0);
      expect(popular).toBeGreaterThanOrEqual(0);
      expect(theirs).toBeLessThan(popular);
    });

    it('falls back to plain popularity with no client on the booking', async () => {
      const { suggestions } = await suggestPlaces(`Popular`, { limit: 8 });
      const labels = suggestions.map((suggestion) => suggestion.primary);

      expect(labels.indexOf(`Popular Tower ${stamp}`)).toBeLessThan(
        labels.indexOf(`Popular Annexe ${stamp}`),
      );
    });

    it('offers each location once, not twice', async () => {
      // A favourite is also a saved location. Offering it in both lists would
      // make the operator choose between two identical lines.
      const { suggestions } = await suggestPlaces(`Popular`, { clientId });
      const labels = suggestions.map((suggestion) => suggestion.primary);

      expect(new Set(labels).size).toBe(labels.length);
    });
  });

  describe('candidates from bookings', () => {
    const typed = `Frequent Address ${stamp}`;

    beforeAll(async () => {
      if (!raw) return;

      // Enough uses to clear the threshold, plus a one-off that must not
      // appear.
      for (let i = 0; i < MIN_USES; i += 1) {
        const job = await raw.job.create({
          data: {
            reference: `CAND-${stamp}-${i}`,
            jobType: 'TRANSFER',
            status: 'COMPLETED',
            scheduledAt: new Date(),
            pickupText: typed,
            dropoffText: 'Heathrow Terminal 5',
          },
        });
        jobIds.push(job.id);
      }

      const once = await raw.job.create({
        data: {
          reference: `CAND-${stamp}-once`,
          jobType: 'TRANSFER',
          status: 'COMPLETED',
          scheduledAt: new Date(),
          pickupText: `One Off ${stamp}`,
          dropoffText: 'Heathrow Terminal 5',
        },
      });
      jobIds.push(once.id);
    });

    it('offers an address people keep typing', async () => {
      const candidates = await locationCandidates(500);
      const mine = candidates.find((candidate) => candidate.address === typed);

      expect(mine, 'the frequently-typed address was not offered').toBeTruthy();
      expect(mine!.uses).toBeGreaterThanOrEqual(MIN_USES);
    });

    it('leaves a one-off alone', async () => {
      // Free-typed addresses include typos and half-addresses. Saving all of
      // them fills the autocomplete with the noise it exists to replace.
      const candidates = await locationCandidates(500);
      expect(
        candidates.some((candidate) => candidate.address === `One Off ${stamp}`),
      ).toBe(false);
    });

    it('never offers something already saved', async () => {
      // Heathrow Terminal 5 is on every one of those fixtures as the dropoff
      // and is seeded, so it is the exact case worth checking.
      const candidates = await locationCandidates(500);
      expect(
        candidates.some(
          (candidate) => candidate.address === 'Heathrow Terminal 5',
        ),
      ).toBe(false);
    });

    it('saves a chosen candidate with the bookings it already has', async () => {
      // So it sorts where it belongs on the booking form immediately, rather
      // than sitting at the bottom until somebody chooses it again.
      const result = await saveCandidates([typed], {});
      expect(result.created).toBe(1);

      const saved = await raw!.location.findFirst({ where: { address: typed } });
      expect(saved).toBeTruthy();
      locationIds.push(saved!.id);
      expect(saved!.useCount).toBeGreaterThanOrEqual(MIN_USES);
    });

    it('drops it from the candidates once saved', async () => {
      const candidates = await locationCandidates(500);
      expect(
        candidates.some((candidate) => candidate.address === typed),
      ).toBe(false);
    });

    it('skips and names one that is already saved rather than failing', async () => {
      // Two people tidying the same list is normal.
      const result = await saveCandidates([typed], {});
      expect(result.created).toBe(0);
      expect(result.skipped).toEqual([typed]);
    });
  });
});
