import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The Prisma client, extended so that soft deletes are the default rather
 * than something every caller has to remember.
 *
 * `docs/specs/phase-0-foundation.md` calls this "middleware". Prisma's `$use`
 * middleware is deprecated, so it is implemented as a client extension —
 * same guarantee, supported API.
 *
 * Known limitation: the extension applies to top-level operations. Rows
 * loaded through a nested `include` are *not* filtered, because Prisma gives
 * an extension no hook into relation loading. Any `include` that can reach a
 * soft-deleted row must carry its own `where: { deletedAt: null }`. The
 * repository helpers in `lib/db/` do this so feature code does not have to.
 */

/** Every model carrying a `deletedAt` column. */
const SOFT_DELETE_MODELS = new Set([
  'User',
  'Client',
  'Account',
  'Driver',
  'Vehicle',
  'Document',
  'Location',
  'RateCard',
  'Job',
  'JobExpense',
  'Invoice',
  'DriverPayout',
]);

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

type ArgsWithFlag = {
  where?: Record<string, unknown>;
  includeDeleted?: boolean;
  data?: unknown;
};

/**
 * Opt out of the soft-delete filter for one query.
 *
 * `prisma.job.findMany(includeDeleted({ where: { clientId } }))`
 *
 * Deliberately verbose: seeing soft-deleted rows is an administrative act
 * (restore, audit trail, ADMIN-only views) and should be visible in review.
 */
export function includeDeleted<T extends object>(args: T): T {
  return { ...args, includeDeleted: true } as T;
}

function modelDelegate(
  client: PrismaClient,
  model: string,
): {
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<unknown>;
} {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const delegates = client as unknown as Record<
    string,
    {
      update: (args: unknown) => Promise<unknown>;
      updateMany: (args: unknown) => Promise<unknown>;
    }
  >;
  const delegate = delegates[key];
  if (!delegate) throw new Error(`No Prisma delegate for model ${model}`);
  return delegate;
}

function buildClient() {
  const base = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

  return base.$extends({
    name: 'softDelete',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !SOFT_DELETE_MODELS.has(model)) {
            return query(args);
          }

          const typed = (args ?? {}) as ArgsWithFlag;
          const { includeDeleted: bypass, ...rest } = typed;

          if (bypass) return query(rest as typeof args);

          if (READ_OPERATIONS.has(operation)) {
            const where = rest.where ?? {};
            // An explicit `deletedAt` in the caller's where wins — that is
            // how a restore screen asks for the deleted rows specifically.
            if ('deletedAt' in where) return query(rest as typeof args);
            return query({
              ...rest,
              where: { ...where, deletedAt: null },
            } as typeof args);
          }

          // Rewrite destructive operations. These run against the base client
          // so this extension does not re-enter itself.
          if (operation === 'delete') {
            return modelDelegate(base, model).update({
              where: rest.where,
              data: { deletedAt: new Date() },
            }) as ReturnType<typeof query>;
          }

          if (operation === 'deleteMany') {
            return modelDelegate(base, model).updateMany({
              where: { ...(rest.where ?? {}), deletedAt: null },
              data: { deletedAt: new Date() },
            }) as ReturnType<typeof query>;
          }

          // Writes (create, update, upsert) still need the filter on their
          // `where` so an update cannot resurrect a deleted row by accident.
          if (operation === 'update' || operation === 'updateMany') {
            const where = rest.where ?? {};
            if ('deletedAt' in where) return query(rest as typeof args);
            return query({
              ...rest,
              where: { ...where, deletedAt: null },
            } as typeof args);
          }

          return query(rest as typeof args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof buildClient>;

/**
 * One client per process. Next.js hot-reloads modules in development, which
 * without this would open a new pool on every save until Postgres refuses
 * connections.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: ExtendedPrismaClient;
};

export const prisma: ExtendedPrismaClient =
  globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export { Prisma };
