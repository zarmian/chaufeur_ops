import { afterAll, describe, expect, it } from 'vitest';
import { withAudit } from './audit';
import { includeDeleted, prisma } from './prisma';

/**
 * The transactional guarantee in Phase 0.3: a failed mutation leaves no
 * audit entry, and a successful one always has one.
 *
 * Needs a real database — the rollback is Postgres doing the work. Set
 * TEST_DATABASE_URL to run.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!DATABASE_AVAILABLE)('withAudit', () => {
  const createdClients: string[] = [];

  afterAll(async () => {
    for (const id of createdClients) {
      await prisma.auditLog.deleteMany({ where: { entityId: id } });
    }
    await prisma.$disconnect();
  });

  it('writes an audit row alongside a create', async () => {
    const name = `audit-create-${Date.now()}`;

    const client = await withAudit('Client', 'create', async (tx) => {
      const created = await tx.client.create({
        data: { name, normalisedName: name },
      });
      return { entityId: created.id, after: created, result: created };
    });
    createdClients.push(client.id);

    const entries = await prisma.auditLog.findMany({
      where: { entity: 'Client', entityId: client.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('create');
    expect(entries[0]!.before).toBeNull();
    expect(entries[0]!.after).toMatchObject({ name });
  });

  it('captures before and after on an update', async () => {
    const name = `audit-update-${Date.now()}`;
    const created = await prisma.client.create({
      data: { name, normalisedName: name },
    });
    createdClients.push(created.id);

    await withAudit('Client', 'update', async (tx) => {
      const before = await tx.client.findUniqueOrThrow({
        where: { id: created.id },
      });
      const after = await tx.client.update({
        where: { id: created.id },
        data: { paymentTermsDays: 30 },
      });
      return { entityId: created.id, before, after, result: after };
    });

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: created.id, action: 'update' },
    });
    expect(entry?.before).toMatchObject({ paymentTermsDays: 14 });
    expect(entry?.after).toMatchObject({ paymentTermsDays: 30 });
  });

  it('records the acting user and IP', async () => {
    const name = `audit-actor-${Date.now()}`;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

    const client = await withAudit(
      'Client',
      'create',
      async (tx) => {
        const created = await tx.client.create({
          data: { name, normalisedName: name },
        });
        return { entityId: created.id, after: created, result: created };
      },
      { userId: admin?.id ?? null, ip: '203.0.113.7' },
    );
    createdClients.push(client.id);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: client.id },
    });
    expect(entry.ip).toBe('203.0.113.7');
    if (admin) expect(entry.userId).toBe(admin.id);
  });

  it('rolls the audit entry back when the mutation fails', async () => {
    const name = `audit-rollback-${Date.now()}`;
    const created = await prisma.client.create({
      data: { name, normalisedName: name },
    });
    createdClients.push(created.id);

    await expect(
      withAudit('Client', 'update', async (tx) => {
        await tx.client.update({
          where: { id: created.id },
          data: { paymentTermsDays: 45 },
        });
        throw new Error('deliberate failure after the write');
      }),
    ).rejects.toThrow('deliberate failure');

    // Neither the change nor its audit entry survived.
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.paymentTermsDays).toBe(14);

    const entries = await prisma.auditLog.findMany({
      where: { entityId: created.id },
    });
    expect(entries).toHaveLength(0);
  });

  it('audits a soft delete as a delete', async () => {
    const name = `audit-delete-${Date.now()}`;
    const created = await prisma.client.create({
      data: { name, normalisedName: name },
    });
    createdClients.push(created.id);

    await withAudit('Client', 'delete', async (tx) => {
      const before = await tx.client.findUniqueOrThrow({
        where: { id: created.id },
      });
      await tx.client.update({
        where: { id: created.id },
        data: { deletedAt: new Date() },
      });
      return { entityId: created.id, before, result: null };
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: created.id, action: 'delete' },
    });
    expect(entry.before).toMatchObject({ name });
    expect(entry.after).toBeNull();

    const survivors = await prisma.client.findMany(
      includeDeleted({ where: { id: created.id } }),
    );
    expect(survivors).toHaveLength(1);
  });
});
