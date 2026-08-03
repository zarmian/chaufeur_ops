import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completeInstall,
  INSTALL_COMPLETE_KEY,
  isInstallComplete,
} from './install';
import { includeDeleted, prisma } from './prisma';

/**
 * The security property that matters for the first-run bootstrap: it can be
 * used exactly once, and never again — including when two requests race.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const TEST_EMAIL_DOMAIN = '@install-test.invalid';

describe.skipIf(!DATABASE_AVAILABLE)('first-run install', () => {
  async function clearInstallState() {
    await prisma.setting.deleteMany({ where: { key: INSTALL_COMPLETE_KEY } });
    const users = await prisma.user.findMany(
      includeDeleted({
        where: { email: { endsWith: TEST_EMAIL_DOMAIN } },
        select: { id: true },
      }),
    );
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${'%' + TEST_EMAIL_DOMAIN}`;
    }
  }

  /** Hide any pre-existing users so the install looks fresh. */
  async function withFreshInstall<T>(fn: () => Promise<T>): Promise<T> {
    const realUsers = await prisma.user.findMany({ select: { id: true } });
    const ids = realUsers.map((u) => u.id);
    await prisma.$executeRaw`UPDATE "User" SET "deletedAt" = now() WHERE id = ANY(${ids}::text[])`;
    await prisma.setting.deleteMany({ where: { key: INSTALL_COMPLETE_KEY } });
    try {
      return await fn();
    } finally {
      await prisma.$executeRaw`UPDATE "User" SET "deletedAt" = NULL WHERE id = ANY(${ids}::text[])`;
    }
  }

  beforeEach(async () => {
    await clearInstallState();
  });

  afterAll(async () => {
    await clearInstallState();
    await prisma.$disconnect();
  });

  it('reports an install as complete when an admin already exists', async () => {
    // The CI database is seeded, so this is the normal production state.
    expect(await isInstallComplete()).toBe(true);
  });

  it('creates the first administrator and the baseline data', async () => {
    await withFreshInstall(async () => {
      expect(await isInstallComplete()).toBe(false);

      const result = await completeInstall({
        email: `first${TEST_EMAIL_DOMAIN}`,
        name: 'First Admin',
        password: 'a-sufficiently-long-password',
      });

      expect(result.ok).toBe(true);

      const created = await prisma.user.findUniqueOrThrow({
        where: { email: `first${TEST_EMAIL_DOMAIN}` },
      });
      expect(created.role).toBe('ADMIN');
      // Never the plaintext.
      expect(created.passwordHash).not.toContain('sufficiently');
      expect(created.passwordHash.startsWith('$argon2id$')).toBe(true);

      expect(await prisma.zone.count()).toBeGreaterThan(0);
      expect(
        await prisma.rateCard.count({ where: { isDefault: true } }),
      ).toBeGreaterThan(0);
    });
  });

  it('refuses a second run', async () => {
    await withFreshInstall(async () => {
      const first = await completeInstall({
        email: `once${TEST_EMAIL_DOMAIN}`,
        name: 'First',
        password: 'a-sufficiently-long-password',
      });
      expect(first.ok).toBe(true);

      const second = await completeInstall({
        email: `twice${TEST_EMAIL_DOMAIN}`,
        name: 'Second',
        password: 'a-sufficiently-long-password',
      });

      expect(second).toEqual({ ok: false, reason: 'already_installed' });
      expect(
        await prisma.user.findUnique({
          where: { email: `twice${TEST_EMAIL_DOMAIN}` },
        }),
      ).toBeNull();
    });
  });

  it('lets only one of two simultaneous claims win', async () => {
    // The marker row's primary key is the mutex. Without it, two operators
    // hitting /setup at the same moment could both become administrators.
    await withFreshInstall(async () => {
      const [a, b] = await Promise.all([
        completeInstall({
          email: `race-a${TEST_EMAIL_DOMAIN}`,
          name: 'Racer A',
          password: 'a-sufficiently-long-password',
        }),
        completeInstall({
          email: `race-b${TEST_EMAIL_DOMAIN}`,
          name: 'Racer B',
          password: 'a-sufficiently-long-password',
        }),
      ]);

      const winners = [a, b].filter((r) => r.ok);
      expect(winners).toHaveLength(1);

      const admins = await prisma.user.count({
        where: { email: { endsWith: TEST_EMAIL_DOMAIN } },
      });
      expect(admins).toBe(1);
    });
  });

  it('marks the install complete, so the page stops offering itself', async () => {
    await withFreshInstall(async () => {
      await completeInstall({
        email: `marker${TEST_EMAIL_DOMAIN}`,
        name: 'Marker',
        password: 'a-sufficiently-long-password',
      });

      const marker = await prisma.setting.findUnique({
        where: { key: INSTALL_COMPLETE_KEY },
      });
      expect(marker).not.toBeNull();
      expect(await isInstallComplete()).toBe(true);
    });
  });
});
