import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEEP, previewReset, runReset, type RawClient } from './reset';

/**
 * The reset, against a real database.
 *
 * Two promises are being kept here and they pull against each other: that
 * everything operational is gone, and that the operator is not locked out of
 * their own install with their branding missing. `TRUNCATE ... CASCADE`
 * reaches whatever references the tables it is given, so the second is not
 * automatic — it has to be checked, and a reset that quietly took the users
 * with it would otherwise report success.
 *
 * Runs against its own database so a suite of tests is not wiped mid-run.
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

/** Its own database, created and dropped here. */
const SCRATCH = 'ops_reset_probe';
const adminUrl = process.env.TEST_DATABASE_URL ?? '';
const scratchUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH}$1`);

let admin: PrismaClient | null = null;
let scratch: PrismaClient | null = null;

describe.skipIf(!DATABASE_AVAILABLE)('runReset', () => {
  let ready = false;

  beforeAll(async () => {
    if (!DATABASE_AVAILABLE) return;

    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}"`);

    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });

    // Two tables are enough to prove the rule: one named in KEEP and one not.
    // The real schema is not needed and would make this a migration test.
    await scratch.$executeRawUnsafe(
      `CREATE TABLE "Setting" (key text PRIMARY KEY, value text)`,
    );
    await scratch.$executeRawUnsafe(
      `CREATE TABLE "Client" (id text PRIMARY KEY, name text)`,
    );
    // A child row referencing a wiped parent, so CASCADE has something to do.
    await scratch.$executeRawUnsafe(
      `CREATE TABLE "Job" (id text PRIMARY KEY, "clientId" text REFERENCES "Client"(id))`,
    );
    await scratch.$executeRawUnsafe(
      `CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY)`,
    );

    await scratch.$executeRawUnsafe(`INSERT INTO "Setting" VALUES ('branding', '{}')`);
    await scratch.$executeRawUnsafe(`INSERT INTO "Client" VALUES ('c1', 'Kingsway')`);
    await scratch.$executeRawUnsafe(`INSERT INTO "Job" VALUES ('j1', 'c1')`);
    await scratch.$executeRawUnsafe(`INSERT INTO "_prisma_migrations" VALUES ('m1')`);

    ready = true;
  }, 60_000);

  afterAll(async () => {
    await scratch?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
      await admin.$disconnect();
    }
  });

  const client = () => scratch as unknown as RawClient;

  it('separates what is kept from what is emptied, and counts it', async () => {
    if (!ready) return;
    const preview = await previewReset(client());

    expect(preview.keep.map((entry) => entry.table)).toContain('Setting');
    expect(preview.wipe.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(['Client', 'Job']),
    );
    // Two rows to remove: the client and the job.
    expect(preview.totalRows).toBe(2);
  });

  it('never offers to empty the migration history', async () => {
    if (!ready) return;
    // Losing it would leave a schema no migration could be applied to again.
    const preview = await previewReset(client());
    const named = [...preview.keep, ...preview.wipe].map((entry) => entry.table);
    expect(named).not.toContain('_prisma_migrations');
  });

  it('changes nothing when only previewing', async () => {
    if (!ready) return;
    await previewReset(client());
    const rows = await scratch!.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Job"`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('empties the rest and keeps configuration', async () => {
    if (!ready) return;
    const outcome = await runReset(client());

    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toBe(2);
    // The promise that matters most: CASCADE did not reach the settings.
    expect(outcome.collateral).toEqual([]);
    expect(outcome.remaining).toEqual([]);

    const settings = await scratch!.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Setting"`,
    );
    expect(Number(settings[0]!.count)).toBe(1);

    const jobs = await scratch!.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Job"`,
    );
    expect(Number(jobs[0]!.count)).toBe(0);

    const migrations = await scratch!.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`,
    );
    expect(Number(migrations[0]!.count)).toBe(1);
  });

  it('is safe to run twice', async () => {
    if (!ready) return;
    const outcome = await runReset(client());
    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toBe(0);
  });

  it('keeps the tables the product cannot lose', async () => {
    // A guard on the list itself. Dropping User or Setting from it would
    // sign every administrator out of an install they still own.
    expect(KEEP).toContain('User');
    expect(KEEP).toContain('Session');
    expect(KEEP).toContain('Setting');
  });
});
