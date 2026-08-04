import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Human-facing reference numbers — `DRV-0147`, and later `WLX-000767`.
 *
 * They exist because "the driver on job clx7a9f2..." is not something anyone
 * says out loud. Once allocated a reference never changes, so it can be
 * written on paperwork.
 *
 * The prefix comes from settings in Phase 3; Phase 1 needs only the driver
 * series, whose prefix is not customer-specific.
 */

export const DRIVER_REFERENCE_PREFIX = 'DRV';
export const DRIVER_REFERENCE_PAD = 4;

/** How many times to retry when two creates race for the same number. */
const MAX_ATTEMPTS = 5;

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
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(reference.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The next free driver reference.
 *
 * Derived from the highest existing number rather than a row count, so
 * deleting DRV-0003 does not cause the next driver to reuse it. Soft-deleted
 * drivers are included in the scan for exactly that reason — a reference must
 * never be handed to a second person.
 */
export async function peekNextDriverReference(): Promise<string> {
  const highest = await highestDriverSequence();
  return formatReference(
    DRIVER_REFERENCE_PREFIX,
    highest + 1,
    DRIVER_REFERENCE_PAD,
  );
}

async function highestDriverSequence(): Promise<number> {
  // Ordering lexically would put DRV-0009 above DRV-0010, so the numeric part
  // is extracted in SQL. Includes soft-deleted rows deliberately.
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING(reference FROM '^${Prisma.raw(DRIVER_REFERENCE_PREFIX)}-(\\d+)$') AS INTEGER)) AS max
    FROM "Driver"
    WHERE reference ~ ${`^${DRIVER_REFERENCE_PREFIX}-\\d+$`}
  `;
  return rows[0]?.max ?? 0;
}

/**
 * Create a driver, allocating its reference.
 *
 * `reference` is unique, so a race between two operators adding a driver at
 * the same moment ends with one unique-constraint violation rather than two
 * drivers sharing a number. That is the safe failure, and retrying it is
 * cheap — so this retries rather than surfacing it.
 */
export async function withDriverReference<T>(
  create: (reference: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reference = await peekNextDriverReference();
    try {
      return await create(reference);
    } catch (error) {
      const isDuplicateReference =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('reference');

      if (!isDuplicateReference) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Could not allocate a driver reference');
}
