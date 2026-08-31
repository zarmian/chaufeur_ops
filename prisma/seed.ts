import { randomBytes } from 'node:crypto';
import { rawPrismaClient } from '../lib/raw-prisma';
import { INSTALL_COMPLETE_KEY, seedBaseline, ZONES } from '../lib/install';
import { hashPassword } from '../lib/password';
import { seedFleet } from './seed-fleet';
import { seedJobs } from './seed-jobs';
import { seedSampleData } from './seed-phase1';

/**
 * Seeds the minimum a fresh install needs: one administrator, the standard
 * London zones and a default rate card.
 *
 * The same job the `/setup` page does from a browser — both call
 * `seedBaseline`, so the two paths cannot drift apart.
 *
 * Safe to re-run: everything is keyed on a natural identifier, so a second
 * run does not create a second admin or duplicate zones.
 *
 * Nothing here names a customer. The example company is generic; Phase 3's
 * branding settings capture the real details.
 */

// The seed client is intentionally unextended: it must be able to see and
// repair soft-deleted rows.
/*
 * Prisma 7 needs a driver adapter; a bare client throws at construction.
 * `DIRECT_URL` first because these scripts do administrative work — seeding,
 * first-run setup, preflight checks — and a pooled connection in transaction
 * mode cannot run all of it.
 */
const prisma = rawPrismaClient(process.env.DIRECT_URL || process.env.DATABASE_URL);

async function seedAdmin(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com')
    .trim()
    .toLowerCase();
  const name = process.env.SEED_ADMIN_NAME ?? 'Administrator';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`✓ Admin ${email} already exists — left untouched`);
    return;
  }

  // A generated password beats a well-known default that survives to
  // production because nobody got round to changing it.
  const password =
    process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');

  await prisma.user.create({
    data: {
      email,
      name,
      role: 'ADMIN',
      passwordHash: await hashPassword(password),
    },
  });

  console.log(`✓ Created ADMIN ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`  Password: ${password}`);
    console.log('  Save it now — it is not stored anywhere and not recoverable.');
  }
}

/**
 * Non-admin users for the end-to-end suite, which has to prove that a role
 * is refused a screen — something a single admin account cannot demonstrate.
 * Off unless asked for, so a production seed never creates a spare login.
 */
async function seedE2EUsers(): Promise<void> {
  if (process.env.SEED_E2E_USERS !== 'true') return;

  const users = [
    {
      email: 'viewer@example.com',
      name: 'Test Viewer',
      role: 'VIEWER' as const,
      password: process.env.SEED_VIEWER_PASSWORD ?? 'ci-viewer-password',
    },
    {
      email: 'ops@example.com',
      name: 'Test Ops',
      role: 'OPS' as const,
      password: process.env.SEED_OPS_PASSWORD ?? 'ci-ops-password',
    },
    {
      email: 'accounts@example.com',
      name: 'Test Accounts',
      role: 'ACCOUNTS' as const,
      password: process.env.SEED_ACCOUNTS_PASSWORD ?? 'ci-accounts-password',
    },
  ];

  for (const user of users) {
    const passwordHash = await hashPassword(user.password);
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, passwordHash, active: true },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash,
      },
    });
  }

  console.log(`✓ ${users.length} test users (SEED_E2E_USERS=true)`);
  console.log('  Do not enable this on a production install.');
}

/**
 * Mark the install claimed, so `/setup` stops offering itself. Without this a
 * seeded install would still show the bootstrap page until someone noticed.
 */
async function markInstalled(): Promise<void> {
  await prisma.setting.upsert({
    where: { key: INSTALL_COMPLETE_KEY },
    update: {},
    create: {
      key: INSTALL_COMPLETE_KEY,
      value: { completedAt: new Date().toISOString(), via: 'seed' },
    },
  });
}

async function main(): Promise<void> {
  console.log('Seeding…');
  await seedAdmin();
  await seedE2EUsers();

  await prisma.$transaction(async (tx) => {
    await seedBaseline(tx);
  });
  console.log(`✓ ${ZONES.length} zones and the default rate card`);
  console.log('  Fares are zero — set the real rates in Phase 4.');

  await seedSampleData(prisma);
  // Fleet before jobs: the job seeder assigns from whatever drivers exist, so
  // seeding them the other way round leaves 50,000 jobs sharing five drivers.
  await seedFleet(prisma);
  await seedJobs(prisma);

  await markInstalled();
  console.log('✓ Install marked complete — /setup is now inert');
  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
