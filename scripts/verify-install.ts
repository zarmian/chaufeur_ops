/**
 * Preflight check for a new install.
 *
 * Run it after pointing the app at a database and before letting anyone log
 * in. It answers the questions that otherwise get discovered at 6am: are the
 * migrations applied, is there an admin, is the pooled connection actually
 * pooled, is anything still on a placeholder value.
 *
 *   npx tsx scripts/verify-install.ts
 *
 * Exits non-zero if anything is wrong, so it can gate a deploy.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Level = 'ok' | 'warn' | 'fail';

const results: Array<{ level: Level; label: string; detail: string }> = [];

function record(level: Level, label: string, detail: string): void {
  results.push({ level, label, detail });
}

function checkEnvironment(): void {
  const required = ['DATABASE_URL', 'DIRECT_URL', 'CRON_SECRET'];
  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      record('fail', key, 'not set');
    } else if (/placeholder|changeme|your[-_]/i.test(value)) {
      record('fail', key, 'still holds a placeholder value');
    } else {
      record('ok', key, 'set');
    }
  }

  // Supabase's pooled connection needs pgbouncer mode declared, or Prisma
  // will try to use prepared statements the pooler cannot support.
  const url = process.env.DATABASE_URL ?? '';
  if (url.includes('pooler.supabase.com')) {
    if (url.includes(':6543') && !url.includes('pgbouncer=true')) {
      record(
        'fail',
        'DATABASE_URL',
        'points at the Supabase pooler on 6543 without ?pgbouncer=true — prepared statements will fail intermittently',
      );
    } else {
      record('ok', 'DATABASE_URL', 'Supabase pooled connection looks right');
    }

    const direct = process.env.DIRECT_URL ?? '';
    if (direct.includes(':6543')) {
      record(
        'fail',
        'DIRECT_URL',
        'must be the direct connection (port 5432), not the pooler — migrations cannot run through pgbouncer',
      );
    }
  }

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    record('ok', 'File storage', 'Vercel Blob token present');
  } else {
    record(
      'warn',
      'File storage',
      'BLOB_READ_WRITE_TOKEN not set — document upload will be unavailable',
    );
  }
}

async function checkDatabase(): Promise<void> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    record('ok', 'Database', `reachable in ${Date.now() - startedAt}ms`);
  } catch (error) {
    record(
      'fail',
      'Database',
      `unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  try {
    const applied = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`;

    const pending = applied.filter((row) => row.finished_at === null);
    if (applied.length === 0) {
      record('fail', 'Migrations', 'none applied — run `npm run db:deploy`');
    } else if (pending.length > 0) {
      record(
        'fail',
        'Migrations',
        `${pending.length} did not finish: ${pending.map((p) => p.migration_name).join(', ')}`,
      );
    } else {
      record('ok', 'Migrations', `${applied.length} applied`);
    }
  } catch {
    record('fail', 'Migrations', 'no migration history — run `npm run db:deploy`');
  }
}

async function checkSeed(): Promise<void> {
  try {
    const [admins, zones, rateCards, testUsers] = await Promise.all([
      prisma.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
      prisma.zone.count(),
      prisma.rateCard.count({ where: { isDefault: true, deletedAt: null } }),
      prisma.user.count({ where: { email: { endsWith: '@example.com' } } }),
    ]);

    record(
      admins > 0 ? 'ok' : 'fail',
      'Admin user',
      admins > 0 ? `${admins} present` : 'none — run `npm run db:seed`',
    );
    record(
      zones > 0 ? 'ok' : 'warn',
      'Zones',
      zones > 0 ? `${zones} seeded` : 'none — run `npm run db:seed`',
    );
    record(
      rateCards > 0 ? 'ok' : 'warn',
      'Default rate card',
      rateCards > 0 ? 'present' : 'none — run `npm run db:seed`',
    );

    if (testUsers > 0 && process.env.NODE_ENV === 'production') {
      record(
        'fail',
        'Test users',
        `${testUsers} @example.com account(s) on a production install — delete them`,
      );
    }
  } catch (error) {
    record(
      'fail',
      'Seed data',
      `could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  checkEnvironment();
  await checkDatabase();
  if (!results.some((r) => r.label === 'Database' && r.level === 'fail')) {
    await checkSeed();
  }

  const symbol: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };
  const width = Math.max(...results.map((r) => r.label.length));

  console.log('');
  for (const result of results) {
    console.log(
      `${symbol[result.level]} ${result.label.padEnd(width)}  ${result.detail}`,
    );
  }

  const failures = results.filter((r) => r.level === 'fail').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  console.log('');

  if (failures > 0) {
    console.log(`${failures} problem${failures === 1 ? '' : 's'} to fix before going live.`);
    process.exitCode = 1;
  } else {
    console.log(
      warnings > 0
        ? `Ready. ${warnings} warning${warnings === 1 ? '' : 's'} — none blocking.`
        : 'Ready.',
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error('Verification failed to run:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
