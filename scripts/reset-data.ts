import { PrismaClient } from '@prisma/client';
import { previewReset, runReset, type RawClient } from '../lib/reset';

/**
 * The reset, from a terminal.
 *
 * Settings → Danger zone does the same thing with a button, and both go
 * through `lib/reset.ts` so they cannot mean different things. This exists
 * for the cases the browser cannot reach: an install whose administrator is
 * locked out, a database being prepared before anybody signs in, or a reset
 * somebody wants in a deploy script.
 *
 * Run it against the database directly, never through the pooler:
 *
 *   DIRECT_URL="postgresql://…:5432/postgres" \
 *   CONFIRM_RESET=DELETE-ALL-OPERATIONAL-DATA \
 *   npx tsx scripts/reset-data.ts
 *
 * There is no undo. Take a backup first — on Supabase that is one button.
 */

const CONFIRMATION = 'DELETE-ALL-OPERATIONAL-DATA';

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Set DIRECT_URL (preferred) or DATABASE_URL to the database to reset.');
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const client = prisma as unknown as RawClient;

  try {
    const preview = await previewReset(client);

    // Named, so nobody discovers which database they were pointed at
    // afterwards.
    console.log(`\nDatabase: ${describe(url)}`);

    console.log(`\nKeeping ${preview.keep.length} tables:`);
    for (const { table, rows } of preview.keep) {
      console.log(`  ${table.padEnd(26)} ${rows} rows`);
    }

    console.log(`\nEmptying ${preview.wipe.length} tables (${preview.totalRows} rows):`);
    for (const { table, rows } of preview.wipe) {
      if (rows > 0) console.log(`  ${table.padEnd(26)} ${rows} rows`);
    }

    if (process.env.CONFIRM_RESET !== CONFIRMATION) {
      console.log(
        `\nNothing has been changed. To go ahead, re-run with CONFIRM_RESET=${CONFIRMATION}\n`,
      );
      return;
    }

    const outcome = await runReset(client);

    console.log('\nDone.');
    if (outcome.collateral.length > 0) {
      console.error(
        `\nWARNING: these were meant to survive and did not: ${outcome.collateral.join(', ')}`,
      );
    }
    if (outcome.remaining.length > 0) {
      console.error(`\nWARNING: still holding rows: ${outcome.remaining.join(', ')}`);
    }
    if (!outcome.ok) {
      process.exitCode = 1;
      return;
    }

    console.log(`\n${outcome.removed} rows removed. The install is ready for real data.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

/** Host and database, never the password. */
function describe(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
