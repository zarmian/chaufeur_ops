import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listClients } from './clients';
import { DEFAULT_THRESHOLDS } from './compliance';
import { listDrivers } from './drivers';
import { listVehicles } from './vehicles';
import { parseListParams } from './list-params';

/**
 * The search box on the driver, vehicle and client lists.
 *
 * This exists because of a defect that shipped and stayed shipped. The driver
 * list's `where` ended with `phone: { contains: normalisePhone(q) }`, and
 * `normalisePhone` strips everything that is not a digit — so a search for a
 * *name*, the commonest thing anybody types on that screen, normalised to the
 * empty string. `contains: ''` is `LIKE '%%'` in SQL: it matches every row
 * rather than none. Searching "Dispatch" returned all 152 drivers instead of
 * the 82 whose name contained it, and the list came back looking exactly as it
 * had a moment earlier — indistinguishable, to whoever was using it, from a
 * search box wired to nothing.
 *
 * Nothing caught it. There were no tests over these queries at all, and the
 * failure is invisible from the code: every clause is individually correct.
 * It only shows when you count the rows.
 *
 * So each test below asserts a *count against a known answer*, never merely
 * that something came back. A test that checked "at least one match" would
 * have passed happily throughout.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/**
 * A word no other fixture will contain, and deliberately **all letters**.
 *
 * That is the point rather than a detail: the defect only appears for a term
 * holding no digits, because that is what normalises to the empty string. A
 * token with a number in it would take the phone clause down a legitimate
 * path and the test would pass whether or not the bug was fixed.
 */
const TOKEN = `Zzqx${[...stamp].map((d) => 'abcdefghij'[Number(d)]).join('')}`;

// The defaults. Nothing here depends on compliance; the lists just need them.
const THRESHOLDS = DEFAULT_THRESHOLDS;

/** No filters set — the state a list is in when somebody just types a search. */
const NO_DRIVER_FILTERS = { status: null, compliance: null, archived: false };
const NO_VEHICLE_FILTERS = {
  status: null,
  vehicleClass: null,
  compliance: null,
  ownership: null,
  archived: false,
};
const NO_CLIENT_FILTERS = { archived: false, accountId: null };

function params(q: string) {
  return parseListParams({ q, pageSize: '200' });
}

describe.skipIf(!DATABASE_AVAILABLE)('list search', () => {
  const driverIds: string[] = [];
  const vehicleIds: string[] = [];
  const clientIds: string[] = [];

  beforeAll(async () => {
    if (!raw) return;
    await raw.$connect();

    // One driver whose *name* carries the token, and one whose name does not
    // but whose phone does. A correct name search finds the first and not the
    // second; the broken one found both, and everything else besides.
    const named = await raw.driver.create({
      data: {
        reference: `SR-${stamp}-A`,
        name: `${TOKEN} Fixture`,
        phone: `07700${stamp}`,
        status: 'ACTIVE',
      },
    });
    const other = await raw.driver.create({
      data: {
        reference: `SR-${stamp}-B`,
        name: `Unrelated Fixture ${stamp}`,
        phone: `07711${stamp}`,
        status: 'ACTIVE',
      },
    });
    driverIds.push(named.id, other.id);

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `SV${stamp}`,
        normalisedRegistration: `SV${stamp}`,
        make: `${TOKEN}Motors`,
        model: 'Saloon',
        vehicleClass: 'SALOON',
      },
    });
    vehicleIds.push(vehicle.id);

    const client = await raw.client.create({
      data: { name: `${TOKEN} Client`, normalisedName: `${TOKEN} client`.toLowerCase() },
    });
    clientIds.push(client.id);
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driver.deleteMany({ where: { id: { in: driverIds } } });
    await raw.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    await raw.client.deleteMany({ where: { id: { in: clientIds } } });
    await raw.$disconnect();
  });

  describe('drivers', () => {
    it('matches a name and nothing else', async () => {
      // The defect, stated as a count. Before the fix this returned every
      // driver in the table.
      const result = await listDrivers(params(TOKEN), NO_DRIVER_FILTERS, THRESHOLDS);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toContain(TOKEN);
    });

    it('does not return the whole table for a term with no digits', async () => {
      const all = await listDrivers(params(''), NO_DRIVER_FILTERS, THRESHOLDS);
      const searched = await listDrivers(params('Zzqxnothingmatchesthis'), NO_DRIVER_FILTERS, THRESHOLDS);

      expect(all.total).toBeGreaterThan(1);
      // The heart of it: a term that matches nobody must return nobody.
      expect(searched.rows).toHaveLength(0);
      expect(searched.total).toBe(0);
    });

    it('still finds a driver by phone number', async () => {
      // The clause that caused the trouble is not removed, only guarded — a
      // phone search has to keep working.
      const result = await listDrivers(params(`07700${stamp}`), NO_DRIVER_FILTERS, THRESHOLDS);
      expect(result.rows.map((row) => row.id)).toContain(driverIds[0]);
    });

    it('finds a phone typed with spaces or in international form', async () => {
      const spaced = await listDrivers(params(`07700 ${stamp}`), NO_DRIVER_FILTERS, THRESHOLDS);
      const international = await listDrivers(params(`+447700${stamp}`), NO_DRIVER_FILTERS, THRESHOLDS);
      expect(spaced.rows.map((row) => row.id)).toContain(driverIds[0]);
      expect(international.rows.map((row) => row.id)).toContain(driverIds[0]);
    });

    it('still finds a driver by reference', async () => {
      const result = await listDrivers(params(`SR-${stamp}-A`), NO_DRIVER_FILTERS, THRESHOLDS);
      expect(result.rows.map((row) => row.id)).toContain(driverIds[0]);
    });
  });

  describe('vehicles', () => {
    it('matches a registration and nothing else', async () => {
      const result = await listVehicles(params(`SV${stamp}`), NO_VEHICLE_FILTERS, THRESHOLDS);
      expect(result.rows).toHaveLength(1);
    });

    it('matches a registration typed with a space, as it is printed', async () => {
      const result = await listVehicles(params(`SV ${stamp}`), NO_VEHICLE_FILTERS, THRESHOLDS);
      expect(result.rows).toHaveLength(1);
    });

    it('does not return the whole fleet for a term that normalises away', async () => {
      // Punctuation only. `normaliseRegistration('---')` is `''`, which
      // unguarded would match every vehicle.
      const result = await listVehicles(params('---'), NO_VEHICLE_FILTERS, THRESHOLDS);
      expect(result.rows).toHaveLength(0);
    });

    it('still finds a vehicle by make', async () => {
      const result = await listVehicles(params(`${TOKEN}Motors`), NO_VEHICLE_FILTERS, THRESHOLDS);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('clients', () => {
    it('matches a name and nothing else', async () => {
      const result = await listClients(params(TOKEN), NO_CLIENT_FILTERS);
      expect(result.rows).toHaveLength(1);
    });

    it('does not return every client for a term that normalises away', async () => {
      const result = await listClients(params('---'), NO_CLIENT_FILTERS);
      expect(result.rows).toHaveLength(0);
    });
  });
});
