import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma, type JobType } from '@prisma/client';
import { hashPassword } from './password';
import { prisma } from './prisma';

/**
 * First-run install.
 *
 * A fresh deployment has tables (Vercel runs `prisma migrate deploy` during
 * the build) but no users, and therefore no way in. This module creates that
 * first administrator, either from the seed script or from the one-time
 * `/setup` page.
 *
 * Both paths share the baseline data below so a web-bootstrapped install and
 * a seeded one cannot drift apart.
 *
 * The install is guarded by a row in `Setting`, not by a user count. The
 * primary key makes claiming it atomic: two simultaneous requests cannot both
 * succeed, because the second `INSERT` violates the key inside its own
 * transaction.
 */

export const INSTALL_COMPLETE_KEY = 'install.completed';

export const ZONES: Array<{ name: string; postcodes: string[] }> = [
  { name: 'Heathrow', postcodes: ['TW6', 'TW14', 'UB7', 'UB3'] },
  { name: 'Gatwick', postcodes: ['RH6'] },
  { name: 'Luton', postcodes: ['LU2'] },
  { name: 'Stansted', postcodes: ['CM24'] },
  { name: 'London City', postcodes: ['E16'] },
  {
    name: 'Central London',
    postcodes: [
      'W1', 'W2', 'SW1', 'SW3', 'SW7', 'WC1', 'WC2', 'EC1', 'EC2', 'EC3',
      'EC4', 'NW1', 'SE1',
    ],
  },
  {
    name: 'Greater London',
    postcodes: [
      'E', 'N', 'NW', 'SE', 'SW', 'W', 'BR', 'CR', 'DA', 'EN', 'HA', 'IG',
      'KT', 'RM', 'SM', 'TW', 'UB', 'WD',
    ],
  },
  { name: 'Outside M25', postcodes: [] },
];

/** Minimum length for the first administrator's password. */
export const MIN_PASSWORD_LENGTH = 12;

export type InstallResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'already_installed' | 'invalid_token' | 'rate_limited' };

/**
 * The token that authorises `/setup`.
 *
 * Defaults to `CRON_SECRET` so a fresh install needs no extra variable. Set
 * `SETUP_TOKEN` to separate the two if you would rather not share one secret
 * between the bootstrap and the scheduler.
 */
export function setupToken(): string | null {
  return process.env.SETUP_TOKEN || process.env.CRON_SECRET || null;
}

/** Constant-time comparison, so the token cannot be recovered by timing. */
export function tokenMatches(supplied: string): boolean {
  const expected = setupToken();
  if (!expected) return false;
  // Hash both sides first: timingSafeEqual throws on length mismatch, which
  // would itself leak the expected length.
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** True once an install has been claimed. Cheap enough to call per request. */
export async function isInstallComplete(): Promise<boolean> {
  const [marker, anyUser] = await Promise.all([
    prisma.setting.findUnique({ where: { key: INSTALL_COMPLETE_KEY } }),
    prisma.user.findFirst({ select: { id: true } }),
  ]);
  // Either signal counts. A database seeded before this module existed has
  // users but no marker, and must not offer /setup to the internet.
  return marker !== null || anyUser !== null;
}

/**
 * Just the operations `seedBaseline` performs.
 *
 * Declared structurally rather than as `Prisma.TransactionClient` because the
 * seed script uses a plain client and the app uses the soft-delete-extended
 * one, and their generated transaction types are not assignable to each
 * other. This is the common shape both satisfy.
 */
export interface BaselineClient {
  zone: {
    upsert(args: {
      where: { name: string };
      update: { postcodes: string[] };
      create: { name: string; postcodes: string[] };
    }): Promise<unknown>;
  };
  rateCard: {
    findFirst(args: {
      where: { isDefault: boolean; deletedAt: null };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: { name: string; activeFrom: Date; isDefault: boolean };
    }): Promise<{ id: string }>;
  };
  rateCardRule: {
    createMany(args: {
      data: Array<{
        rateCardId: string;
        jobType: JobType;
        freeWaitMinutes: number;
        priority: number;
      }>;
    }): Promise<unknown>;
  };
}

/**
 * Zones and the default rate card — everything a usable install needs that
 * is not a user. Idempotent, so re-running is safe.
 */
export async function seedBaseline(tx: BaselineClient): Promise<void> {
  for (const zone of ZONES) {
    await tx.zone.upsert({
      where: { name: zone.name },
      update: { postcodes: zone.postcodes },
      create: { name: zone.name, postcodes: zone.postcodes },
    });
  }

  const existingCard = await tx.rateCard.findFirst({
    where: { isDefault: true, deletedAt: null },
  });
  if (existingCard) return;

  const card = await tx.rateCard.create({
    data: {
      name: 'Standard',
      activeFrom: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)),
      isDefault: true,
    },
  });

  // Fares stay at zero. Real commercial rates are a business decision made in
  // Phase 4 — seeding invented prices would put fiction into revenue reports.
  await tx.rateCardRule.createMany({
    data: [
      {
        rateCardId: card.id,
        jobType: 'AIRPORT_TRANSFER',
        // Airport pickups get the longer free wait: a delayed flight is not
        // the client's fault and 15 minutes never survives a baggage hall.
        freeWaitMinutes: 45,
        priority: 10,
      },
      { rateCardId: card.id, jobType: 'TRANSFER', freeWaitMinutes: 15, priority: 10 },
      { rateCardId: card.id, jobType: 'AS_DIRECTED', freeWaitMinutes: 15, priority: 10 },
    ],
  });
}

/**
 * Claim the install: create the first administrator and the baseline data.
 *
 * Everything happens in one transaction that begins by inserting the marker
 * row. A concurrent second call fails on the primary key and rolls back
 * without creating a second administrator.
 */
export async function completeInstall(input: {
  email: string;
  name: string;
  password: string;
}): Promise<InstallResult> {
  const passwordHash = await hashPassword(input.password);

  try {
    const userId = await prisma.$transaction(async (tx) => {
      // The mutex. If this throws, someone else already claimed the install.
      await tx.setting.create({
        data: {
          key: INSTALL_COMPLETE_KEY,
          value: { completedAt: new Date().toISOString() },
        },
      });

      const user = await tx.user.create({
        data: {
          email: input.email.trim().toLowerCase(),
          name: input.name.trim(),
          role: 'ADMIN',
          passwordHash,
        },
      });

      await seedBaseline(tx);

      await tx.auditLog.create({
        data: {
          entity: 'User',
          entityId: user.id,
          action: 'create',
          userId: user.id,
          after: { email: user.email, name: user.name, role: user.role },
        },
      });

      return user.id;
    });

    return { ok: true, userId };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // Unique violation: the marker row, or the email, already exists.
      return { ok: false, reason: 'already_installed' };
    }
    throw error;
  }
}
