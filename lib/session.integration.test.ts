import { afterAll, describe, expect, it } from 'vitest';
import { hashSessionToken, purgeExpiredSessions, revokeAllSessions } from './session';
import { prisma } from './prisma';

/**
 * The point of keeping sessions in Postgres rather than a JWT: access can be
 * withdrawn immediately. These prove that against a real database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!DATABASE_AVAILABLE)('database sessions', () => {
  const userIds: string[] = [];

  afterAll(async () => {
    for (const id of userIds) {
      await prisma.session.deleteMany({ where: { userId: id } });
      await prisma.user.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }
    await prisma.$disconnect();
  });

  async function makeUser() {
    const user = await prisma.user.create({
      data: {
        email: `session-test-${Date.now()}-${Math.random()}@example.test`,
        name: 'Session Test',
        role: 'VIEWER',
        passwordHash: 'not-used-here',
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function issue(userId: string, expiresInMs: number) {
    const rawToken = `raw-${Math.random().toString(36).slice(2)}`;
    await prisma.session.create({
      data: {
        sessionToken: hashSessionToken(rawToken),
        userId,
        expires: new Date(Date.now() + expiresInMs),
      },
    });
    return rawToken;
  }

  it('stores the hash, never the token itself', async () => {
    const user = await makeUser();
    const rawToken = await issue(user.id, 60_000);

    const stored = await prisma.session.findFirst({ where: { userId: user.id } });
    expect(stored?.sessionToken).not.toBe(rawToken);
    expect(stored?.sessionToken).toBe(hashSessionToken(rawToken));
  });

  it('finds a session by the hash of its token', async () => {
    const user = await makeUser();
    const rawToken = await issue(user.id, 60_000);

    const found = await prisma.session.findUnique({
      where: { sessionToken: hashSessionToken(rawToken) },
    });
    expect(found?.userId).toBe(user.id);
  });

  it('revoking drops every session a user holds, not just the current one', async () => {
    const user = await makeUser();
    await issue(user.id, 60_000);
    await issue(user.id, 60_000);
    await issue(user.id, 60_000);

    expect(await revokeAllSessions(user.id)).toBe(3);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('purges expired sessions and leaves live ones alone', async () => {
    const user = await makeUser();
    await issue(user.id, -60_000); // already expired
    await issue(user.id, 60_000);

    await purgeExpiredSessions();

    const remaining = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.expires.getTime()).toBeGreaterThan(Date.now());
  });

  it('cascades session deletion when the user row is removed', async () => {
    const user = await makeUser();
    await issue(user.id, 60_000);

    // A hard delete only happens in administrative tooling, but the FK must
    // not leave orphaned sessions behind if it does.
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ${user.id}`;
    userIds.splice(userIds.indexOf(user.id), 1);

    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });
});
