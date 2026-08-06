import type { Prisma } from '@prisma/client';
import type { ListParams } from '../list-params';
import { prisma } from '../prisma';
import { unreconciledPence } from './allocate';
import { TXN_KINDS, type BankTxnKind } from './classify';

/**
 * The reconciliation list.
 *
 * The header figure is the point of the screen: money that moved through the
 * bank and that no invoice, payout or cost accounts for. An operator's
 * question is "are the books straight", and the answer is that number
 * reaching zero.
 *
 * Like every other list here it is server-paginated, and the totals are
 * computed across the whole filter rather than the page — a total covering
 * only page one would look authoritative and be wrong.
 */

export interface TransactionFilters {
  q: string | null;
  kind: string | null;
  statementId: string | null;
  from: Date | null;
  to: Date | null;
  /** `allocated` | `unallocated` | null for both. */
  state: string | null;
}

export function buildTransactionWhere(
  filters: TransactionFilters,
): Prisma.BankTransactionWhereInput {
  const where: Prisma.BankTransactionWhereInput = {};

  if (filters.q) {
    where.OR = [
      { description: { contains: filters.q, mode: 'insensitive' } },
      { bankRef: { contains: filters.q, mode: 'insensitive' } },
      { client: { name: { contains: filters.q, mode: 'insensitive' } } },
      { account: { name: { contains: filters.q, mode: 'insensitive' } } },
    ];
  }

  if (filters.kind) where.kind = filters.kind as never;
  if (filters.statementId) where.statementId = filters.statementId;

  if (filters.from || filters.to) {
    where.occurredOn = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  if (filters.state === 'allocated') where.allocatedAt = { not: null };
  if (filters.state === 'unallocated') where.allocatedAt = null;

  return where;
}

const LIST_SELECT = {
  id: true,
  occurredOn: true,
  description: true,
  amountPence: true,
  bankRef: true,
  kind: true,
  allocatedAt: true,
  allocatedPence: true,
  statementId: true,
  client: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, registration: true } },
} as const;

export interface ReconciliationTotals {
  count: number;
  inPence: number;
  outPence: number;
  unreconciledInPence: number;
  unreconciledOutPence: number;
  unreconciledPence: number;
}

export async function listTransactions(
  params: ListParams,
  filters: TransactionFilters,
) {
  const where = buildTransactionWhere(filters);

  const [rows, total, forTotals] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      orderBy: orderFor(params),
      skip: params.skip,
      take: params.take,
      select: LIST_SELECT,
    }),
    prisma.bankTransaction.count({ where }),
    // The whole filtered set, not the page. Only three small columns, so the
    // cost of being right is a column scan rather than a second query per
    // row.
    prisma.bankTransaction.findMany({
      where,
      select: { amountPence: true, allocatedPence: true, kind: true },
    }),
  ]);

  const unreconciled = unreconciledPence(forTotals);

  const totals: ReconciliationTotals = {
    count: total,
    inPence: forTotals
      .filter((t) => t.amountPence > 0 && t.kind !== 'TRANSFER')
      .reduce((sum, t) => sum + t.amountPence, 0),
    outPence: forTotals
      .filter((t) => t.amountPence < 0 && t.kind !== 'TRANSFER')
      .reduce((sum, t) => sum + Math.abs(t.amountPence), 0),
    unreconciledInPence: unreconciled.inPence,
    unreconciledOutPence: unreconciled.outPence,
    unreconciledPence: unreconciled.totalPence,
  };

  return { rows, total, totals };
}

function orderFor(params: ListParams): Prisma.BankTransactionOrderByWithRelationInput[] {
  const dir = params.dir;
  switch (params.sort) {
    case 'amount':
      return [{ amountPence: dir }, { id: 'asc' }];
    case 'kind':
      return [{ kind: dir }, { occurredOn: 'desc' }];
    case 'description':
      return [{ description: dir }, { id: 'asc' }];
    default:
      // Newest first, then a stable tiebreak so paging never repeats a row.
      return [{ occurredOn: dir === 'asc' ? 'asc' : 'desc' }, { id: 'asc' }];
  }
}

/**
 * How much is sitting in each state.
 *
 * Rendered as filter chips, so the count is visible before the operator
 * clicks. The unclassified count is the one that matters: it is the work
 * left to do.
 */
export async function countsByKind(
  filters: TransactionFilters,
): Promise<Array<{ kind: BankTxnKind; label: string; count: number }>> {
  const where = buildTransactionWhere({ ...filters, kind: null });

  const grouped = await prisma.bankTransaction.groupBy({
    by: ['kind'],
    where,
    _count: { _all: true },
  });

  const counts = new Map(grouped.map((g) => [String(g.kind), g._count._all]));

  return TXN_KINDS.map((kind) => ({
    kind: kind.value,
    label: kind.label,
    count: counts.get(kind.value) ?? 0,
  }));
}

export async function listStatements() {
  return prisma.bankStatement.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

/**
 * One transaction, with everything it was matched to and why.
 *
 * The `why` is not decoration. A wrong classification has to be traceable
 * back to the rule that made it, or the operator can only fix the symptom.
 */
export async function getTransaction(id: string) {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      statement: true,
      client: true,
      account: true,
      driver: true,
      vehicle: true,
      allocations: {
        include: {
          invoice: { select: { id: true, number: true, grossPence: true } },
          payout: {
            select: { id: true, totalPence: true, driver: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!txn) return null;

  const rule = txn.matchedRuleId
    ? await prisma.bankRule.findUnique({ where: { id: txn.matchedRuleId } })
    : null;

  return { ...txn, rule };
}

export async function transactionsForExport(filters: TransactionFilters) {
  return prisma.bankTransaction.findMany({
    where: buildTransactionWhere(filters),
    orderBy: [{ occurredOn: 'asc' }, { id: 'asc' }],
    select: {
      ...LIST_SELECT,
      allocations: {
        select: {
          amountPence: true,
          invoice: { select: { number: true } },
        },
      },
    },
    take: 10_000,
  });
}

export function toTransactionExportRows(
  rows: Array<{
    occurredOn: Date;
    description: string;
    amountPence: number;
    bankRef: string | null;
    kind: string;
    allocatedAt: Date | null;
    allocatedPence: number;
    client: { name: string } | null;
    account: { name: string } | null;
    driver: { name: string } | null;
    vehicle: { registration: string } | null;
    allocations: Array<{ amountPence: number; invoice: { number: string } | null }>;
  }>,
) {
  return rows.map((row) => ({
    Date: row.occurredOn.toISOString().slice(0, 10),
    Description: row.description,
    Reference: row.bankRef ?? '',
    // Signed, and in major units, because a spreadsheet is where somebody
    // sums a column and a mix of signs and magnitudes is how that goes wrong.
    Amount: row.amountPence / 100,
    Classification: row.kind,
    Counterparty:
      row.account?.name ??
      row.client?.name ??
      row.driver?.name ??
      row.vehicle?.registration ??
      '',
    Allocated: row.allocatedAt ? row.allocatedPence / 100 : 0,
    Unallocated: (Math.abs(row.amountPence) - row.allocatedPence) / 100,
    Invoices: row.allocations
      .map((a) => a.invoice?.number)
      .filter(Boolean)
      .join(', '),
  }));
}
