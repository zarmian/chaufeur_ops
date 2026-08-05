import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseHeader, parseCsv } from './csv';
import { ENTITY_DEFS, IMPORT_ENTITIES } from './import-schema';
import { buildErrorReport, buildTemplate, dryRun, runImport } from './import';

/**
 * The import against a real database.
 *
 * The arithmetic of validation is unit-tested; what only this can prove is
 * the property the feature rests on — that running the same file twice
 * updates rather than duplicating. Without it a correction workflow is
 * impossible, and an operator who spots a typo in row 40 has no way to fix it
 * except by hand.
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
const stamp = String(Date.now()).slice(-6);

const PLATE_A = `IM${stamp}A`;
const PLATE_B = `IM${stamp}B`;
const PHONE_A = `07700${stamp}1`;
const PHONE_B = `07700${stamp}2`;

const VEHICLES_CSV = [
  'registration,make,model,class,seats,mot_expiry,insurance_expiry',
  `${PLATE_A},Mercedes-Benz,E-Class,EXECUTIVE,4,2028-02-28,2028-06-30`,
  `${PLATE_B},BMW,5 Series,EXECUTIVE,4,2028-03-31,`,
].join('\n');

const DRIVERS_CSV = [
  'name,phone,email,dvla_licence_expiry,phv_badge_expiry,vehicle_registration',
  `Import Tester One,${PHONE_A},one${stamp}@example.test,2029-01-31,2028-12-31,${PLATE_A}`,
  `Import Tester Two,${PHONE_B},,,,`,
].join('\n');

describe.skipIf(!DATABASE_AVAILABLE)('csv import', () => {
  const createdVehicleIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    await raw?.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.driver.deleteMany({
      where: { normalisedPhone: { in: [PHONE_A, PHONE_B] } },
    });
    await raw.vehicle.deleteMany({
      where: { normalisedRegistration: { in: [PLATE_A, PLATE_B] } },
    });
    await raw.client.deleteMany({
      where: { id: { in: createdClientIds } },
    });
    await raw.auditLog.deleteMany({
      where: { entityId: { startsWith: 'import:' } },
    });
    void createdVehicleIds;
    void createdDriverIds;
    await raw.$disconnect();
  });

  it('creates the vehicles in the file', async () => {
    const summary = await runImport('vehicles', VEHICLES_CSV, 'fleet.csv', audit);

    expect(summary.created).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.errors).toEqual([]);

    const vehicle = await raw!.vehicle.findFirstOrThrow({
      where: { normalisedRegistration: PLATE_A },
    });
    expect(vehicle.make).toBe('Mercedes-Benz');
    expect(vehicle.motExpiry?.toISOString().slice(0, 10)).toBe('2028-02-28');
    // A blank expiry imports as absent and lands in the compliance backlog.
    const second = await raw!.vehicle.findFirstOrThrow({
      where: { normalisedRegistration: PLATE_B },
    });
    expect(second.insuranceExpiry).toBeNull();
  });

  it('updates rather than duplicating on a re-import', async () => {
    // The property the whole feature rests on.
    const changed = VEHICLES_CSV.replace('E-Class', 'S-Class');
    const summary = await runImport('vehicles', changed, 'fleet.csv', audit);

    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(2);

    const matching = await raw!.vehicle.findMany({
      where: { normalisedRegistration: PLATE_A },
    });
    expect(matching).toHaveLength(1);
    expect(matching[0]!.model).toBe('S-Class');
  });

  it('matches a registration written differently', async () => {
    // `ab12 cde` and `AB12CDE` are the same car.
    const lower = VEHICLES_CSV.replace(PLATE_A, PLATE_A.toLowerCase());
    const summary = await runImport('vehicles', lower, 'fleet.csv', audit);
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(2);
  });

  it('creates drivers and links them to a vehicle by registration', async () => {
    // Spec 3.5.7 — the two files link in one pass.
    const summary = await runImport('drivers', DRIVERS_CSV, 'drivers.csv', audit);

    expect(summary.created).toBe(2);
    expect(summary.errors).toEqual([]);

    const driver = await raw!.driver.findFirstOrThrow({
      where: { normalisedPhone: PHONE_A },
      include: { assignedVehicle: true },
    });
    expect(driver.assignedVehicle?.normalisedRegistration).toBe(PLATE_A);
    // A reference is allocated when the file does not carry one.
    expect(driver.reference).toMatch(/^DRV-\d+$/);
  });

  it('imports a driver whose vehicle is not on the fleet, and says so', async () => {
    // The driver is still worth having; the vehicle file may not be loaded
    // yet. Failing the row would make the order of the two files matter.
    const csv = [
      'name,phone,vehicle_registration',
      `Import Tester Three,07700${stamp}3,ZZ99 ZZZ`,
    ].join('\n');

    const summary = await runImport('drivers', csv, 'drivers.csv', audit);
    expect(summary.created).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.message).toMatch(/No vehicle/);

    await raw!.driver.deleteMany({ where: { normalisedPhone: `07700${stamp}3` } });
  });

  it('matches a driver on the phone however it was written', async () => {
    const international = DRIVERS_CSV.replace(
      PHONE_A,
      `+44${PHONE_A.slice(1)}`,
    );
    const summary = await runImport('drivers', international, 'drivers.csv', audit);
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(2);
  });

  it('imports the valid rows and reports the rest', async () => {
    // Spec 3.5.5. Refusing the whole file for one bad date would mean the
    // import never happens.
    const csv = [
      'registration,make,model,mot_expiry',
      `IM${stamp}C,Audi,A6,2028-01-31`,
      `IM${stamp}D,,A8,2028-01-31`,
      `IM${stamp}E,Audi,A4,the fifteenth`,
    ].join('\n');

    const summary = await runImport('vehicles', csv, 'partial.csv', audit);
    expect(summary.created).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.errors).toHaveLength(2);
    expect(summary.errors.map((error) => error.line).sort()).toEqual([3, 4]);

    await raw!.vehicle.deleteMany({
      where: {
        normalisedRegistration: {
          in: [`IM${stamp}C`, `IM${stamp}D`, `IM${stamp}E`],
        },
      },
    });
  });

  it('reports a row duplicated inside the file rather than letting it win', async () => {
    const csv = [
      'registration,make,model',
      `IM${stamp}F,Audi,A6`,
      `IM${stamp}F,Audi,A8`,
    ].join('\n');

    const summary = await runImport('vehicles', csv, 'dupes.csv', audit);
    expect(summary.created).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.errors[0]!.message).toMatch(/line 2/);

    // The first occurrence is the one that landed.
    const vehicle = await raw!.vehicle.findFirstOrThrow({
      where: { normalisedRegistration: `IM${stamp}F` },
    });
    expect(vehicle.model).toBe('A6');

    await raw!.vehicle.deleteMany({
      where: { normalisedRegistration: `IM${stamp}F` },
    });
  });

  it('imports clients and matches them on name plus contact', async () => {
    const csv = [
      'name,contact_email,contact_phone,payment_terms_days',
      `Northwind ${stamp},north${stamp}@example.test,020 7946 0000,30`,
    ].join('\n');

    const first = await runImport('clients', csv, 'clients.csv', audit);
    expect(first.created).toBe(1);

    const again = await runImport('clients', csv, 'clients.csv', audit);
    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);

    const clients = await raw!.client.findMany({
      where: { contactEmail: `north${stamp}@example.test` },
    });
    expect(clients).toHaveLength(1);
    createdClientIds.push(...clients.map((client) => client.id));
  });

  it('records who imported what', async () => {
    // Spec 3.5.9. The question asked six months later.
    const entry = await raw!.auditLog.findFirst({
      where: { entityId: 'import:vehicles' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect(entry?.after).toMatchObject({ fileName: expect.any(String) });
  });

  it('previews without writing anything', async () => {
    const csv = [
      'registration,make,model',
      `IM${stamp}G,Audi,A6`,
    ].join('\n');

    const summary = dryRun('vehicles', csv);
    expect(summary.totalRows).toBe(1);
    expect(summary.preview).toHaveLength(1);
    expect(summary.created).toBe(0);

    const vehicle = await raw!.vehicle.findFirst({
      where: { normalisedRegistration: `IM${stamp}G` },
    });
    expect(vehicle).toBeNull();
  });
});

describe('column definitions', () => {
  it('keys every column by the normalised form of its own label', () => {
    // The bug this catches: a column labelled `vehicle_registration` whose
    // key is `registration` is never read, so the value silently vanishes and
    // the importer quietly does less than it says. Nothing else fails — the
    // row imports, just without that field.
    for (const entity of IMPORT_ENTITIES) {
      for (const column of ENTITY_DEFS[entity].columns) {
        expect(
          column.key,
          `${entity}.${column.label} is keyed "${column.key}" but its header normalises to "${normaliseHeader(column.label)}"`,
        ).toBe(normaliseHeader(column.label));
      }
    }
  });

  it('gives every column a distinct key', () => {
    for (const entity of IMPORT_ENTITIES) {
      const keys = ENTITY_DEFS[entity].columns.map((column) => column.key);
      expect(new Set(keys).size, entity).toBe(keys.length);
    }
  });
});

describe('templates', () => {
  it('round-trips: the template a customer downloads imports cleanly', () => {
    // Definition of done. A template whose own example row fails validation
    // is worse than no template.
    for (const entity of ['drivers', 'vehicles', 'clients'] as const) {
      const template = buildTemplate(entity);
      const summary = dryRun(entity, template);
      expect(summary.errors, entity).toEqual([]);
      expect(summary.totalRows, entity).toBe(1);
    }
  });

  it('writes headers the parser then recognises', () => {
    const parsed = parseCsv(buildTemplate('vehicles'));
    expect(parsed.headers).toContain('registration');
    expect(parsed.headers).toContain('motexpiry');
  });

  it('builds an error report naming the row and the problem', () => {
    const summary = dryRun(
      'vehicles',
      'registration,make,model\n,Audi,A6',
    );
    const report = buildErrorReport(summary);
    expect(report).toContain('row,column,problem');
    expect(report).toContain('registration');
  });
});
