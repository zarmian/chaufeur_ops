import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import type { ListParams } from './list-params';
import { prisma } from './prisma';
import { emptyToNull, tidy } from './text';

/**
 * Accounts — the bookers.
 *
 * The client rides; the account placed the booking and is usually who gets
 * invoiced. The legacy system had one free-text "Booker" field holding a mix
 * of the operator's own brand, partner agencies and individual bookers, which
 * is why "which accounts are actually worth having" was unanswerable.
 */

export const accountSchema = z.object({
  name: z.string().trim().min(1, 'Enter the account name').max(200),
  kind: z.enum(['INTERNAL', 'AGENCY', 'CORPORATE', 'INDIVIDUAL']),
  contactName: z.string().trim().max(200).optional().or(z.literal('')),
  contactPhone: z.string().trim().max(50).optional().or(z.literal('')),
  contactEmail: z
    .string()
    .trim()
    .email('Enter a valid email address')
    .optional()
    .or(z.literal('')),
  billingEmail: z
    .string()
    .trim()
    .email('Enter a valid billing email address')
    .optional()
    .or(z.literal('')),
  billingAddress: z.string().trim().max(500).optional().or(z.literal('')),
  vatNumber: z.string().trim().max(50).optional().or(z.literal('')),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(14),
  // How this booker's work is normally taxed. A job may override it.
  vatTreatment: z.enum(['STANDARD', 'INCLUSIVE', 'EXEMPT']).default('STANDARD'),
  commissionPct: z
    .union([z.coerce.number().min(0).max(100), z.literal('')])
    .optional(),
  active: z.coerce.boolean().default(true),
});

export type AccountInput = z.infer<typeof accountSchema>;

function toData(input: AccountInput) {
  return {
    name: tidy(input.name),
    kind: input.kind,
    contactName: emptyToNull(input.contactName),
    contactPhone: emptyToNull(input.contactPhone),
    contactEmail: emptyToNull(input.contactEmail)?.toLowerCase() ?? null,
    billingEmail: emptyToNull(input.billingEmail)?.toLowerCase() ?? null,
    billingAddress: emptyToNull(input.billingAddress),
    vatNumber: emptyToNull(input.vatNumber),
    paymentTermsDays: input.paymentTermsDays,
    vatTreatment: input.vatTreatment,
    // Commission is a percentage, not money — Decimal is right here, and the
    // pence rule does not apply.
    commissionPct:
      input.commissionPct === '' || input.commissionPct === undefined
        ? null
        : new Prisma.Decimal(input.commissionPct),
    active: input.active,
  };
}

export class DuplicateAccountNameError extends Error {
  constructor(readonly existingName: string) {
    super(`An account called "${existingName}" already exists`);
    this.name = 'DuplicateAccountNameError';
  }
}

export interface AccountListFilters {
  kind: string | null;
  archived: boolean;
}

export async function listAccounts(
  params: ListParams,
  filters: AccountListFilters,
) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const where = {
    ...(filters.archived ? { deletedAt: { not: null } } : {}),
    ...(filters.kind
      ? { kind: filters.kind as AccountInput['kind'] }
      : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: 'insensitive' as const } },
            {
              contactName: { contains: params.q, mode: 'insensitive' as const },
            },
            {
              contactEmail: { contains: params.q, mode: 'insensitive' as const },
            },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.account.findMany({
      where,
      orderBy: { name: params.dir },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        name: true,
        kind: true,
        contactName: true,
        paymentTermsDays: true,
        vatTreatment: true,
        active: true,
        deletedAt: true,
        _count: { select: { jobs: true, clients: true } },
      },
    }),
    prisma.account.count({ where }),
  ]);

  // This month's revenue per account, from reconciled finance records. One
  // grouped query rather than one per row.
  const revenue = await prisma.jobFinance.groupBy({
    by: ['jobId'],
    where: {
      job: {
        accountId: { in: rows.map((r) => r.id) },
        scheduledAt: { gte: monthStart },
        status: 'COMPLETED',
      },
    },
    _sum: { totalClientPence: true },
  });

  const jobAccounts = await prisma.job.findMany({
    where: { id: { in: revenue.map((r) => r.jobId) } },
    select: { id: true, accountId: true },
  });
  const accountByJob = new Map(jobAccounts.map((j) => [j.id, j.accountId]));

  const revenueByAccount = new Map<string, number>();
  for (const row of revenue) {
    const accountId = accountByJob.get(row.jobId);
    if (!accountId) continue;
    revenueByAccount.set(
      accountId,
      (revenueByAccount.get(accountId) ?? 0) + (row._sum.totalClientPence ?? 0),
    );
  }

  return {
    rows: rows.map((row) => ({
      ...row,
      monthRevenuePence: revenueByAccount.get(row.id) ?? 0,
    })),
    total,
  };
}

export async function getAccount(id: string) {
  return prisma.account.findUnique({ where: { id } });
}

async function assertNameFree(name: string, excludeId?: string) {
  const existing = await prisma.account.findFirst({
    where: {
      name: { equals: tidy(name), mode: 'insensitive' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { name: true },
  });
  if (existing) throw new DuplicateAccountNameError(existing.name);
}

export async function createAccount(
  input: AccountInput,
  context: AuditContext,
): Promise<{ id: string }> {
  await assertNameFree(input.name);
  return withAudit(
    'Account',
    'create',
    async (tx) => {
      const created = await tx.account.create({ data: toData(input) });
      return { entityId: created.id, after: created, result: { id: created.id } };
    },
    context,
  );
}

export async function updateAccount(
  id: string,
  input: AccountInput,
  context: AuditContext,
): Promise<{ id: string }> {
  await assertNameFree(input.name, id);
  return withAudit(
    'Account',
    'update',
    async (tx) => {
      const before = await tx.account.findUniqueOrThrow({ where: { id } });
      const after = await tx.account.update({ where: { id }, data: toData(input) });
      return { entityId: id, before, after, result: { id } };
    },
    context,
  );
}

/** Archiving is refused while money is still owed against the account. */
export async function archiveAccount(
  id: string,
  context: AuditContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const unpaidInvoices = await prisma.invoice.count({
    where: {
      accountId: id,
      status: { in: ['DRAFT', 'SENT', 'PART_PAID', 'OVERDUE'] },
    },
  });

  if (unpaidInvoices > 0) {
    return {
      ok: false,
      reason: `This account has ${unpaidInvoices} unpaid invoice${
        unpaidInvoices === 1 ? '' : 's'
      }. Settle or cancel them first.`,
    };
  }

  await withAudit(
    'Account',
    'delete',
    async (tx) => {
      const before = await tx.account.findUniqueOrThrow({ where: { id } });
      await tx.account.update({ where: { id }, data: { deletedAt: new Date() } });
      return { entityId: id, before, result: null };
    },
    context,
  );

  return { ok: true };
}
