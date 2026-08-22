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
import { botToken } from '../lib/telegram/config';
import { webhookOwnership } from '../lib/telegram/webhook-owner';

const prisma = new PrismaClient();

type Level = 'ok' | 'warn' | 'fail';

const results: Array<{ level: Level; label: string; detail: string }> = [];

function record(level: Level, label: string, detail: string): void {
  results.push({ level, label, detail });
}

function checkEnvironment(): void {
  /*
   * `APP_URL` is required rather than optional, and it earns that here.
   *
   * Almost nothing needs it — a browser knows its own origin and a PDF
   * renderer is handed one. It matters for messages the system *pushes*: a
   * driver's Telegram job card carries a link to the passenger's name board,
   * and there is no incoming request to resolve that against. It is also what
   * the webhook check below compares against, so an install without it cannot
   * tell whether its own bot is pointed somewhere else.
   */
  const required = ['DATABASE_URL', 'DIRECT_URL', 'CRON_SECRET', 'APP_URL'];
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
    /*
     * Present is not the same as *this install's own*.
     *
     * Nothing here can tell one store from another — the token does not say
     * which one it opens. But object keys carry a UUID, so two installs
     * sharing a store never collide and therefore never complain: one
     * customer's driver licences and insurance certificates simply accumulate
     * in another customer's bucket, indefinitely, with nothing anywhere
     * reporting a fault. Said out loud because it cannot be checked.
     */
    record(
      'ok',
      'File storage',
      'Vercel Blob token present — confirm it opens a store used by no other install',
    );
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

/**
 * Whose install is this bot actually talking to?
 *
 * The most dangerous mistake available when standing up a second install, and
 * the quietest. A Telegram bot has exactly one webhook URL. Give two installs
 * the same bot token and the second one to register wins: from that moment
 * the first company's drivers are accepting jobs, tapping arrival and filing
 * expenses into the second company's database. Every screen still works.
 * Nothing logs an error. It surfaces weeks later as a driver swearing they
 * completed a job that the office has no record of.
 *
 * Nothing in the application registers a webhook — it is done by hand at
 * deploy time — so there is no moment at which this could have been caught.
 * Asking Telegram which URL it holds turns an invisible catastrophe into a
 * red line in a preflight.
 */
async function checkTelegramWebhooks(): Promise<void> {
  for (const bot of ['ops', 'admin'] as const) {
    const label = `Telegram (${bot})`;
    let token: string | null = null;

    try {
      token = await botToken(bot);
    } catch {
      record('warn', label, 'could not read the token — check the Telegram settings');
      continue;
    }

    // No bot configured is a perfectly ordinary state: the ops bot is
    // optional and the admin bot more so.
    if (!token) {
      record('ok', label, 'no bot configured');
      continue;
    }

    let info: { url?: string; last_error_message?: string } | null = null;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getWebhookInfo`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const json = (await response.json()) as {
        ok?: boolean;
        result?: { url?: string; last_error_message?: string };
      };
      if (!json.ok || !json.result) {
        record('fail', label, 'Telegram refused the token — it is wrong or revoked');
        continue;
      }
      info = json.result;
    } catch {
      // Offline, or Telegram unreachable. Not a reason to fail an install.
      record('warn', label, 'could not reach Telegram to check the webhook');
      continue;
    }

    const ownership = webhookOwnership(info.url, process.env.APP_URL);

    if (ownership.state === 'ours') {
      record('ok', label, 'webhook points at this install');
    } else if (ownership.state === 'none') {
      record(
        'warn',
        label,
        'no webhook registered — drivers can be sent messages but cannot reply',
      );
    } else if (ownership.state === 'unknown') {
      record('warn', label, `cannot check the webhook: ${ownership.reason}`);
    } else {
      record(
        'fail',
        label,
        `webhook points at ${ownership.registered}, not this install. ` +
          'This bot belongs somewhere else — give this install its own bot, or ' +
          "every driver reply will land in the other install's database.",
      );
    }

    if (info.last_error_message) {
      record('warn', label, `Telegram's last delivery failed: ${info.last_error_message}`);
    }
  }
}

async function main(): Promise<void> {
  checkEnvironment();
  await checkDatabase();
  if (!results.some((r) => r.label === 'Database' && r.level === 'fail')) {
    await checkSeed();
    // Needs the database: the tokens live in `Setting`, encrypted.
    await checkTelegramWebhooks();
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
