import { Prisma } from '@prisma/client';
import { getBranding } from './branding-store';
import { prisma } from './prisma';

/**
 * Human-facing reference numbers — `DRV-0147`, `JOB-000767`.
 *
 * They exist because "the driver on job clx7a9f2..." is not something anyone
 * says out loud. Once allocated a reference never changes, so it can be
 * written on paperwork.
 *
 * The driver prefix is fixed; the job prefix comes from branding, so each
 * install can use its own. Nothing here names a customer.
 */

export const DRIVER_REFERENCE_PREFIX = 'DRV';
export const DRIVER_REFERENCE_PAD = 4;
export const JOB_REFERENCE_PAD = 6;

/**
 * How many times to retry when concurrent creates race for the same number.
 *
 * Generous because the failure mode is a refused booking. Each attempt is one
 * cheap query plus one insert, so a dozen costs milliseconds even in the
 * worst case, and the worst case is rare.
 */
const MAX_ATTEMPTS = 12;

export function formatReference(
  prefix: string,
  sequence: number,
  pad: number,
): string {
  return `${prefix}-${String(sequence).padStart(pad, '0')}`;
}

/** Pull the numeric part back out, ignoring anything that does not match. */
export function parseReference(
  reference: string,
  prefix: string,
): number | null {
  const match = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`).exec(reference.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * A configured prefix reaches a regular expression and a POSIX pattern, so
 * anything with meaning in either has to be neutralised first.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The tables that carry a reference series.
 *
 * Held as pre-built SQL fragments rather than interpolated strings: the table
 * name is the one part of the query that cannot be a bind parameter, so it
 * must never come from anywhere but this map.
 */
const SERIES_TABLE = {
  driver: Prisma.sql`"Driver"`,
  job: Prisma.sql`"Job"`,
} as const;

type SeriesName = keyof typeof SERIES_TABLE;

/**
 * The highest sequence number already used in a series.
 *
 * Derived from the highest existing number rather than a row count, so
 * deleting `DRV-0003` does not cause the next driver to reuse it.
 * Soft-deleted rows are included for exactly that reason — a reference must
 * never be handed to a second record.
 *
 * The prefix is bound as a parameter on both sides. It is admin-configurable,
 * and a prefix carrying a regex metacharacter would otherwise change what the
 * query matches.
 */
async function highestSequence(
  series: SeriesName,
  prefix: string,
): Promise<number> {
  const capture = `^${escapeRegExp(prefix)}-(\\d+)$`;
  const match = `^${escapeRegExp(prefix)}-\\d+$`;

  // Ordering lexically would put DRV-0009 above DRV-0010, so the numeric part
  // is extracted in SQL.
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING(reference FROM ${capture}) AS INTEGER)) AS max
    FROM ${SERIES_TABLE[series]}
    WHERE reference ~ ${match}
  `;

  return rows[0]?.max ?? 0;
}

export async function peekNextDriverReference(offset = 0): Promise<string> {
  const highest = await highestSequence('driver', DRIVER_REFERENCE_PREFIX);
  return formatReference(
    DRIVER_REFERENCE_PREFIX,
    highest + 1 + offset,
    DRIVER_REFERENCE_PAD,
  );
}

export async function peekNextJobReference(offset = 0): Promise<string> {
  const { jobReferencePrefix } = await getBranding();
  const highest = await highestSequence('job', jobReferencePrefix);
  return formatReference(
    jobReferencePrefix,
    highest + 1 + offset,
    JOB_REFERENCE_PAD,
  );
}

/**
 * Allocate a reference and create the record with it.
 *
 * `reference` is unique, so a race between two operators adding a record at
 * the same moment ends with one unique-constraint violation rather than two
 * records sharing a number. That is the safe failure, and retrying it is
 * cheap — so this retries rather than surfacing it.
 *
 * Two details make the retry actually converge under load, both learned from
 * a CI run where four test files created jobs at once and a booking was
 * refused after five collisions:
 *
 * - **The retry steps past the collision.** Re-reading the highest number is
 *   not enough on its own: every concurrent writer reads the same maximum and
 *   asks for the same next number, so they collide again on the next attempt
 *   and the one after. Offsetting by the attempt count spreads them, so N
 *   writers settle into N adjacent numbers instead of fighting over one.
 * - **A short random wait between attempts.** Without it, writers that
 *   started together stay in lockstep.
 *
 * Neither creates gaps in the ordinary case: the offset is only applied after
 * a collision, and the number it lands on is one another writer has just
 * taken or is about to.
 */
async function withReference<T>(
  peek: (offset: number) => Promise<string>,
  create: (reference: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reference = await peek(attempt);
    try {
      return await create(reference);
    } catch (error) {
      const isDuplicateReference =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('reference');

      if (!isDuplicateReference) throw error;
      lastError = error;

      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * 15 * (attempt + 1)),
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Could not allocate a reference');
}

export function withDriverReference<T>(
  create: (reference: string) => Promise<T>,
): Promise<T> {
  return withReference(peekNextDriverReference, create);
}

export function withJobReference<T>(
  create: (reference: string) => Promise<T>,
): Promise<T> {
  return withReference(peekNextJobReference, create);
}
