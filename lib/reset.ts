import { prisma } from './prisma';

/**
 * Emptying an install of its operational data, keeping how it is set up.
 *
 * Soft delete cannot do this. It is the right default — an operator who
 * deletes a job and wants it back on Monday is why it exists — but it means
 * the application layer has no way to actually clear anything, and
 * `AuditLog`, `InvoiceLine`, `DriverPayoutLine` and `DriverPosition` carry no
 * `deletedAt` at all. Marking rows deleted would leave an install that looked
 * empty and was not: every test job and invoice still there, still counted by
 * anything that reads past the filter.
 *
 * So this works at the table level, which is the only level where gone means
 * gone. Shared by the settings screen and `scripts/reset-data.ts`, so the
 * button and the command cannot drift into meaning different things.
 */

/**
 * What survives: how this install is configured, and who can sign into it.
 *
 * Everything not named here is emptied. That direction is deliberate — a
 * model added next year should be emptied by a reset that predates it. The
 * opposite failure is silent, and turns up later as somebody's test data in
 * a system that was reported clean.
 */
export const KEEP: readonly string[] = [
  'User', // The administrator, so nobody is locked out of their own install.
  'Session', // …and their sign-in, so they are not even signed out.
  'Setting', // Branding, locale, VAT, and every provider's configuration.
  'Zone', // Pricing geography.
  'RateCard',
  'RateCardRule',
  'Location', // Saved addresses, curated on the pricing screen.
];

/** Enough of a Prisma client for this, so the CLI can pass its own. */
export interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface TableCount {
  table: string;
  rows: number;
}

export interface ResetPreview {
  keep: TableCount[];
  wipe: TableCount[];
  /** Rows that would be removed. The number an operator is agreeing to. */
  totalRows: number;
}

export interface ResetOutcome {
  ok: boolean;
  removed: number;
  /** Tables that were meant to survive and did not. */
  collateral: string[];
  /** Tables that were meant to be emptied and were not. */
  remaining: string[];
}

/** Every table Prisma manages, read from the database rather than the schema. */
async function liveTables(client: RawClient): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '\\_prisma%'
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function countRows(
  client: RawClient,
  tables: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

/** What a reset would do, without doing any of it. */
export async function previewReset(
  client: RawClient = prisma as unknown as RawClient,
): Promise<ResetPreview> {
  const tables = await liveTables(client);
  const counts = await countRows(client, tables);
  const keep = new Set(KEEP);

  const kept = tables.filter((table) => keep.has(table));
  const wiped = tables.filter((table) => !keep.has(table));

  return {
    keep: kept.map((table) => ({ table, rows: counts[table] ?? 0 })),
    wipe: wiped.map((table) => ({ table, rows: counts[table] ?? 0 })),
    totalRows: wiped.reduce((sum, table) => sum + (counts[table] ?? 0), 0),
  };
}

/**
 * Empty it, then check that what was emptied is what was meant to be.
 *
 * The verification is not ceremony. `TRUNCATE ... CASCADE` reaches whatever
 * references the tables named, and if that ever included one of the kept
 * tables the operator would be signed out of their own install with their
 * branding gone — and told it had worked.
 */
export async function runReset(
  client: RawClient = prisma as unknown as RawClient,
): Promise<ResetOutcome> {
  const before = await previewReset(client);
  const wipe = before.wipe.map((entry) => entry.table);

  if (wipe.length === 0) {
    return { ok: true, removed: 0, collateral: [], remaining: [] };
  }

  // One statement, so foreign keys never have to be dropped or ordered.
  const quoted = wipe.map((table) => `"${table}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

  const after = await previewReset(client);
  const keptBefore = new Map(before.keep.map((entry) => [entry.table, entry.rows]));

  const collateral = after.keep
    .filter((entry) => entry.rows !== keptBefore.get(entry.table))
    .map((entry) => entry.table);
  const remaining = after.wipe.filter((entry) => entry.rows > 0).map((entry) => entry.table);

  return {
    ok: collateral.length === 0 && remaining.length === 0,
    removed: before.totalRows,
    collateral,
    remaining,
  };
}
