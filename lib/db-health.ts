import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Classify why the database is not usable.
 *
 * A fresh install fails in a small number of predictable ways, and the
 * difference between them is the difference between a five-second fix and an
 * hour of guessing. Prisma knows which one it is; this turns that into
 * something a deployment screen can say out loud.
 *
 * Nothing here ever includes the connection string or the password.
 */

export type DatabaseStatus =
  | { ok: true; latencyMs: number }
  | {
      ok: false;
      reason: 'unreachable' | 'auth_failed' | 'no_database' | 'no_schema' | 'unknown';
      summary: string;
      remedy: string;
      latencyMs: number;
    };

export async function checkDatabase(): Promise<DatabaseStatus> {
  const startedAt = Date.now();

  try {
    // Connectivity first.
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    return { ...classifyConnection(error), latencyMs: Date.now() - startedAt };
  }

  try {
    // Then the schema. A reachable database with no tables is the single most
    // common state for a deployment that built before migrations ran.
    await prisma.user.count();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2021' || error.code === 'P2022')
    ) {
      return {
        ok: false,
        reason: 'no_schema',
        summary: 'The database is reachable but has no tables.',
        remedy:
          'Migrations have not been applied. Redeploy so the build runs `prisma migrate deploy`, or run `npm run db:deploy` against DIRECT_URL.',
        latencyMs: Date.now() - startedAt,
      };
    }
    return {
      ok: false,
      reason: 'unknown',
      summary: 'The database responded but a simple query failed.',
      remedy: 'Check the deployment logs for the underlying error.',
      latencyMs: Date.now() - startedAt,
    };
  }

  return { ok: true, latencyMs: Date.now() - startedAt };
}

function classifyConnection(
  error: unknown,
): Omit<Extract<DatabaseStatus, { ok: false }>, 'latencyMs'> {
  // KnownRequestError carries `code`; InitializationError carries `errorCode`.
  // Connection failures arrive as either, depending on when Prisma noticed.
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof Prisma.PrismaClientInitializationError
        ? error.errorCode
        : undefined;

  switch (code) {
    case 'P1000':
      return {
        ok: false,
        reason: 'auth_failed',
        summary: 'The database refused the credentials.',
        remedy:
          'The password in DATABASE_URL is wrong, or a special character in it needs percent-encoding.',
      };
    case 'P1001':
      return {
        ok: false,
        reason: 'unreachable',
        summary: 'The database server could not be reached.',
        remedy:
          'Check DATABASE_URL points at the pooled connection (port 6543 with ?pgbouncer=true) and that the project is not paused.',
      };
    case 'P1003':
      return {
        ok: false,
        reason: 'no_database',
        summary: 'That database does not exist.',
        remedy: 'Check the database name at the end of DATABASE_URL.',
      };
    default:
      return {
        ok: false,
        reason: 'unreachable',
        summary: 'The database could not be reached.',
        remedy:
          'Check DATABASE_URL and DIRECT_URL are both set on the deployment, and that the database is running.',
      };
  }
}
