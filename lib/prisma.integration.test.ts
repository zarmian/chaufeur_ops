import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { includeDeleted, prisma } from './prisma';

/**
 * Proves the soft-delete extension against a real database.
 *
 * Skipped unless TEST_DATABASE_URL is set, because these assertions are only
 * meaningful against Postgres — Prisma's query engine, not a mock, is the
 * thing under test. Run them with:
 *
 *   TEST_DATABASE_URL=postgresql://… npm run test
 *
 * Point it at a scratch database. The suite creates and deletes rows.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

/** An unextended client, so the tests can see what the extension is hiding. */
const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

describe.skipIf(!DATABASE_AVAILABLE)('soft delete', () => {
  const created: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (raw && created.length > 0) {
      await raw.client.deleteMany({ where: { id: { in: created } } });
      await raw.$disconnect();
    }
    await prisma.$disconnect();
  });

  async function makeClient(name: string) {
    const client = await prisma.client.create({
      data: { name, normalisedName: name.toLowerCase() },
    });
    created.push(client.id);
    return client;
  }

  it('rewrites delete to setting deletedAt, leaving the row in place', async () => {
    const client = await makeClient(`soft-delete-${Date.now()}`);

    await prisma.client.delete({ where: { id: client.id } });

    const stillThere = await raw!.client.findUnique({
      where: { id: client.id },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.deletedAt).toBeInstanceOf(Date);
  });

  it('hides a deleted row from findMany', async () => {
    const client = await makeClient(`hidden-${Date.now()}`);
    await prisma.client.delete({ where: { id: client.id } });

    const found = await prisma.client.findMany({ where: { id: client.id } });
    expect(found).toHaveLength(0);
  });

  it('hides a deleted row from findUnique', async () => {
    const client = await makeClient(`unique-${Date.now()}`);
    await prisma.client.delete({ where: { id: client.id } });

    expect(await prisma.client.findUnique({ where: { id: client.id } })).toBeNull();
  });

  it('excludes deleted rows from count', async () => {
    const client = await makeClient(`counted-${Date.now()}`);
    const before = await prisma.client.count();

    await prisma.client.delete({ where: { id: client.id } });

    expect(await prisma.client.count()).toBe(before - 1);
  });

  it('returns the deleted row when includeDeleted is passed explicitly', async () => {
    const client = await makeClient(`explicit-${Date.now()}`);
    await prisma.client.delete({ where: { id: client.id } });

    const found = await prisma.client.findMany(
      includeDeleted({ where: { id: client.id } }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.deletedAt).not.toBeNull();
  });

  it('honours an explicit deletedAt filter, for a restore screen', async () => {
    const client = await makeClient(`restore-${Date.now()}`);
    await prisma.client.delete({ where: { id: client.id } });

    const deletedOnly = await prisma.client.findMany({
      where: { id: client.id, deletedAt: { not: null } },
    });
    expect(deletedOnly).toHaveLength(1);
  });

  it('refuses to update a deleted row, so it cannot be silently resurrected', async () => {
    const client = await makeClient(`no-resurrect-${Date.now()}`);
    await prisma.client.delete({ where: { id: client.id } });

    await expect(
      prisma.client.update({
        where: { id: client.id },
        data: { name: 'changed' },
      }),
    ).rejects.toThrow();
  });

  it('rewrites deleteMany to updateMany', async () => {
    const stamp = Date.now();
    await makeClient(`bulk-a-${stamp}`);
    await makeClient(`bulk-b-${stamp}`);

    const result = await prisma.client.deleteMany({
      where: { name: { endsWith: `-${stamp}` } },
    });
    expect(result.count).toBe(2);

    const survivors = await raw!.client.findMany({
      where: { name: { endsWith: `-${stamp}` } },
    });
    expect(survivors).toHaveLength(2);
    expect(survivors.every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('leaves models without a deletedAt column alone', async () => {
    // JobEvent is append-only and has no deletedAt. The extension must not
    // try to filter on a column that does not exist.
    await expect(prisma.jobEvent.count()).resolves.toBeTypeOf('number');
  });
});
