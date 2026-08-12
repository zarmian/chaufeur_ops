import { PrismaClient } from '@prisma/client';

/**
 * Empty an install of its operational data, keeping how it is set up.
 *
 * For the point between proving a system works and running it for real: the
 * jobs, clients, drivers and invoices that were entered to test it are in the
 * way, and soft delete cannot remove them. Soft delete is the right default —
 * an operator who deletes a job and needs it back on Monday is why it exists
 * — but it means the application layer has no way to actually clear anything.
 * `AuditLog`, `InvoiceLine`, `DriverPayoutLine` and `DriverPosition` have no
 * `deletedAt` at all and are permanent by design. Marking rows deleted would
 * leave an install that looked empty and was not.
 *
 * So this works at the table level, which is the only level where "gone"
 * means gone.
 *
 * Run it against the database directly, never through the pooler:
 *
 *   DIRECT_URL="postgresql://…:5432/postgres" \
 *   CONFIRM_RESET=DELETE-ALL-OPERATIONAL-DATA \
 *   npx tsx scripts/reset-data.ts
 *
 * There is no undo. Take a backup first — on Supabase that is one button.
 */

/**
 * What survives: how this install is configured, and who can sign into it.
 *
 * Everything not named here is emptied. That direction is deliberate: a model
 * added later is wiped by default rather than quietly surviving a reset and
 * leaving somebody's test data behind, which is the failure that would go
 * unnoticed. The script prints both lists before it touches anything.
 */
const KEEP = [
  'User', // The administrator, so nobody is locked out of their own install.
  'Session', // …and their sign-in, so they are not even logged out.
  'Setting', // Branding, locale, VAT, and every provider's configuration.
  'Zone', // Pricing geography.
  'RateCard',
  'RateCardRule',
  'Location', // Saved addresses, which are curated on the pricing screen.
] as const;

const CONFIRMATION = 'DELETE-ALL-OPERATIONAL-DATA';

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Set DIRECT_URL (preferred) or DATABASE_URL to the database to reset.');
  }

  // Named so nobody discovers which database they were pointed at afterwards.
  const target = describe(url);
  const confirmed = process.env.CONFIRM_RESET === CONFIRMATION;

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const tables = await liveTables(prisma);
    const keep = new Set<string>(KEEP);
    const wipe = tables.filter((table) => !keep.has(table));
    const kept = tables.filter((table) => keep.has(table));

    const before = await countRows(prisma, tables);
    const rowsToDelete = wipe.reduce((sum, table) => sum + (before[table] ?? 0), 0);

    console.log(`\nDatabase: ${target}`);
    console.log(`\nKeeping ${kept.length} tables:`);
    for (const table of kept) console.log(`  ${table.padEnd(26)} ${before[table] ?? 0} rows`);

    console.log(`\nEmptying ${wipe.length} tables (${rowsToDelete} rows):`);
    for (const table of wipe) {
      if ((before[table] ?? 0) > 0) console.log(`  ${table.padEnd(26)} ${before[table]} rows`);
    }

    if (!confirmed) {
      console.log(
        `\nNothing has been changed. To go ahead, re-run with CONFIRM_RESET=${CONFIRMATION}\n`,
      );
      return;
    }

    if (wipe.length === 0) {
      console.log('\nNothing to empty.\n');
      return;
    }

    // One statement, so foreign keys never have to be dropped or ordered.
    // CASCADE only reaches tables referencing these, and every such table is
    // already in the list — asserted below rather than assumed.
    const quoted = wipe.map((table) => `"${table}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

    const after = await countRows(prisma, tables);

    // If CASCADE reached something it was told to keep, say so loudly. A
    // reset that quietly signed the operator out of their own install, or
    // took the branding with it, should not be reported as a success.
    const collateral = kept.filter((table) => (after[table] ?? 0) !== (before[table] ?? 0));
    const remaining = wipe.filter((table) => (after[table] ?? 0) > 0);

    console.log('\nDone.');
    for (const table of kept) console.log(`  kept ${table.padEnd(24)} ${after[table] ?? 0} rows`);

    if (collateral.length > 0) {
      console.error(
        `\nWARNING: these were meant to survive and did not: ${collateral.join(', ')}`,
      );
      process.exitCode = 1;
    }
    if (remaining.length > 0) {
      console.error(`\nWARNING: still holding rows: ${remaining.join(', ')}`);
      process.exitCode = 1;
    }
    if (collateral.length === 0 && remaining.length === 0) {
      console.log(`\n${rowsToDelete} rows removed. The install is ready for real data.\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** Every table Prisma manages, read from the database rather than the schema. */
async function liveTables(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '\\_prisma%'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

async function countRows(
  prisma: PrismaClient,
  tables: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
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
