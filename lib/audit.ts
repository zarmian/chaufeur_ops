import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Every change to a money-bearing or operational record is attributable.
 *
 * The legacy system had one shared admin login and hard deletes, so nobody
 * could answer "who changed this price, and what was it before?". That
 * question is the reason this module is not optional.
 *
 * The audit row is written inside the same transaction as the change, so a
 * failed mutation leaves no entry and a successful one always has one.
 */

export type AuditEntity =
  | 'Job'
  | 'JobSeries'
  | 'JobFinance'
  | 'Invoice'
  | 'Driver'
  | 'Vehicle'
  | 'Client'
  | 'Account'
  | 'Document'
  | 'DriverPayout'
  | 'RateCard'
  | 'Setting'
  | 'User';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore';

export interface AuditContext {
  userId?: string | null;
  ip?: string | null;
}

export interface AuditOutcome<T> {
  /** The record the entry is about. */
  entityId: string;
  /** State before the change. Omit on create. */
  before?: unknown;
  /** State after the change. Omit on delete. */
  after?: unknown;
  /** Whatever the caller wants back. */
  result: T;
}

/** Never copy these into an audit snapshot. */
const REDACTED_KEYS = new Set([
  'passwordHash',
  'password',
  'sessionToken',
  'token',
  'secret',
  'apiKey',
  'authToken',
]);

const REDACTED = '[redacted]';

/**
 * Make a value safe for a `Json` column.
 *
 * Prisma hands back `Decimal` objects, `BigInt` telegram chat ids and `Date`
 * instances. `JSON.stringify` throws on the first BigInt it meets, which
 * would turn an audit write into a failed mutation.
 */
export function toJsonSnapshot(value: unknown): Prisma.InputJsonValue {
  return snapshot(value) as Prisma.InputJsonValue;
}

function snapshot(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();

  if (value instanceof Prisma.Decimal) return value.toString();

  if (Array.isArray(value)) return value.map(snapshot);

  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key) ? REDACTED : snapshot(inner);
    }
    return out;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'function' || typeof value === 'symbol') return null;

  return value;
}

/** Field-level diff, so a reviewer sees the price change and not 40 unchanged columns. */
export function diffSnapshots(
  before: unknown,
  after: unknown,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (
    typeof before !== 'object' ||
    before === null ||
    typeof after !== 'object' ||
    after === null
  ) {
    return changes;
  }

  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord),
  ]);

  for (const key of keys) {
    const from = beforeRecord[key];
    const to = afterRecord[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[key] = { from, to };
    }
  }
  return changes;
}

/**
 * Run a mutation and record it, both inside one transaction.
 *
 * ```ts
 * await withAudit('Job', 'update', async (tx) => {
 *   const before = await tx.job.findUniqueOrThrow({ where: { id } });
 *   const after = await tx.job.update({ where: { id }, data });
 *   return { entityId: id, before, after, result: after };
 * }, ctx);
 * ```
 */
export async function withAudit<T>(
  entity: AuditEntity,
  action: AuditAction,
  fn: (tx: Prisma.TransactionClient) => Promise<AuditOutcome<T>>,
  context: AuditContext = {},
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const outcome = await fn(tx as Prisma.TransactionClient);

    await tx.auditLog.create({
      data: {
        entity,
        entityId: outcome.entityId,
        action,
        userId: context.userId ?? null,
        ip: context.ip ?? null,
        before:
          outcome.before === undefined
            ? Prisma.JsonNull
            : toJsonSnapshot(outcome.before),
        after:
          outcome.after === undefined
            ? Prisma.JsonNull
            : toJsonSnapshot(outcome.after),
      },
    });

    return outcome.result;
  });
}

/**
 * Record something that happened outside a mutation of our own — a webhook
 * acting on a record, or a bulk operation logging per-item results.
 * Prefer `withAudit`; this exists for the cases that genuinely have no
 * enclosing transaction to join.
 */
export async function recordAudit(
  entity: AuditEntity,
  action: AuditAction,
  entityId: string,
  snapshots: { before?: unknown; after?: unknown },
  context: AuditContext = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      entity,
      entityId,
      action,
      userId: context.userId ?? null,
      ip: context.ip ?? null,
      before:
        snapshots.before === undefined
          ? Prisma.JsonNull
          : toJsonSnapshot(snapshots.before),
      after:
        snapshots.after === undefined
          ? Prisma.JsonNull
          : toJsonSnapshot(snapshots.after),
    },
  });
}
