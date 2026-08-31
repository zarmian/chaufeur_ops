import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * A Prisma client pointed at a named database, with none of the extensions on.
 *
 * "Raw" meaning un-extended: no soft-delete filter, no audit. Two kinds of
 * caller want that. Integration tests build fixtures and verify cleanup
 * through it, and they have to be able to see rows the application
 * deliberately hides — a test that could not read a soft-deleted row could
 * not prove the row was soft-deleted. And the operational scripts — seeding,
 * first-run setup, the preflight check, the reset — work below the
 * application's own rules by definition.
 *
 * `lib/prisma.ts` is the client everything else should use. This one is
 * deliberately inconvenient to reach for.
 *
 * It exists as a factory rather than as boilerplate at each call site because
 * Prisma 7 replaced `datasources: { db: { url } }` with a driver adapter, and
 * that construction appeared in forty-six files. Written out forty-six times,
 * the next change to how a connection is made is forty-six edits and one of
 * them gets missed. Written once, it is one — and the type checker will not
 * catch the miss, because a bare `new PrismaClient()` still compiles and only
 * throws when it runs.
 */
export function rawPrismaClient(url: string | undefined): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
}
