import type { Prisma } from '@prisma/client';
import {
  ageInvoices,
  AGING_LABELS,
  outstandingPence,
  type AgingBuckets,
} from './invoices';
import type { ListParams } from './list-params';
import { sumPence } from './money';
import { prisma } from './prisma';

/**
 * The ledger.
 *
 * The legacy system generated invoices and then lost track of them, which is
 * what this exists to fix — so the header totals matter as much as the rows.
 * A list you have to add up by hand is one nobody adds up.
 *
 * Totals are computed across the whole filtered set, not the current page. A
 * total that only covered page one would be worse than none: it would look
 * authoritative and be wrong.
 */

export interface InvoiceFilters {
  /** Free text: the invoice number, or the client or account name. */
  q: string | null;
  status: string | null;
  clientId: string | null;
  accountId: string | null;
  from: Date | null;
  to: Date | null;
  overdueOnly: boolean;
}

export function buildInvoiceWhere(
  filters: InvoiceFilters,
  now: Date = new Date(),
): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {};

  // The number, or whoever is being billed. The toolbar offers a search box,
  // and one that silently matched nothing would be worse than none — an
  // operator would conclude the invoice had gone rather than that the box was
  // ornamental.
  if (filters.q) {
    where.OR = [
      { number: { contains: filters.q, mode: 'insensitive' } },
      { client: { name: { contains: filters.q, mode: 'insensitive' } } },
      { account: { name: { contains: filters.q, mode: 'insensitive' } } },
    ];
  }

  if (filters.status) where.status = filters.status as never;
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.accountId) where.accountId = filters.accountId;

  if (filters.from || filters.to) {
    where.issueDate = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  if (filters.overdueOnly) {
    // Past due *and* not settled. Status alone is not enough — an invoice
    // paid this morning may still be sitting at OVERDUE until the cron runs.
    where.dueDate = { lt: now };
    where.status = { notIn: ['PAID', 'CANCELLED', 'DRAFT'] };
  }

  return where;
}

const LIST_SELECT = {
  id: true,
  number: true,
  issueDate: true,
  dueDate: true,
  netPence: true,
  vatPence: true,
  grossPence: true,
  paidPence: true,
  status: true,
  creditsInvoiceId: true,
  client: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
} as const;

export interface LedgerTotals {
  invoicedPence: number;
  paidPence: number;
  outstandingPence: number;
  count: number;
}

export async function listInvoices(
  params: ListParams,
  filters: InvoiceFilters,
  now: Date = new Date(),
) {
  const where = buildInvoiceWhere(filters, now);

  const [rows, total, aggregate, outstanding] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: orderFor(params),
      skip: params.skip,
      take: params.take,
      select: LIST_SELECT,
    }),
    prisma.invoice.count({ where }),
    // Aggregated in SQL across the whole filter, not the page.
    prisma.invoice.aggregate({
      where,
      _sum: { grossPence: true, paidPence: true },
      _count: true,
    }),
    outstandingAcross(where),
  ]);

  const invoicedPence = aggregate._sum.grossPence ?? 0;
  const paidPence = aggregate._sum.paidPence ?? 0;

  return {
    rows: rows.map((row) => ({
      ...row,
      outstandingPence: outstandingPence(row),
    })),
    total,
    totals: {
      invoicedPence,
      paidPence,
      // Not `invoiced - paid`: an overpayment on one invoice is not a credit
      // against another, and netting them would understate what is owed.
      outstandingPence: outstanding,
      count: aggregate._count,
    } satisfies LedgerTotals,
  };
}

/**
 * What is outstanding across the filter.
 *
 * Floored at zero per invoice before summing, because an overpayment on one
 * invoice is not a credit against another — `SUM(gross) - SUM(paid)` would
 * quietly net them off and understate the debt.
 *
 * This is the one figure the database cannot total for us, because flooring
 * has to happen per invoice before the sum and `SUM(GREATEST(...))` is not
 * expressible through the query builder. Two integer columns per invoice are
 * fetched instead — a year's ledger is thousands of rows, not millions, and
 * a correct total is worth more than an aggregate that quietly nets
 * overpayments off other people's debts.
 */
async function outstandingAcross(
  where: Prisma.InvoiceWhereInput,
): Promise<number> {
  const rows = await prisma.invoice.findMany({
    where,
    select: { grossPence: true, paidPence: true },
  });
  return sumPence(...rows.map((row) => outstandingPence(row)));
}

function orderFor(params: ListParams): Prisma.InvoiceOrderByWithRelationInput {
  switch (params.sort) {
    case 'number':
      return { number: params.dir };
    case 'dueDate':
      return { dueDate: params.dir };
    case 'grossPence':
      return { grossPence: params.dir };
    default:
      return { issueDate: params.dir };
  }
}

export interface AgingRow {
  clientId: string | null;
  accountId: string | null;
  name: string;
  buckets: AgingBuckets;
}

/**
 * Outstanding balances by recipient, bucketed by how overdue they are.
 *
 * Grouped by whoever is actually being billed — the account when there is
 * one, the client otherwise. Grouping by client alone would scatter one
 * agency's debt across every passenger it ever booked for.
 */
export async function agingReport(
  now: Date = new Date(),
): Promise<{ rows: AgingRow[]; totals: AgingBuckets }> {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { notIn: ['DRAFT', 'CANCELLED', 'PAID'] },
    },
    select: {
      grossPence: true,
      paidPence: true,
      dueDate: true,
      clientId: true,
      accountId: true,
      client: { select: { name: true } },
      account: { select: { name: true } },
    },
  });

  const groups = new Map<string, { row: AgingRow; invoices: typeof invoices }>();

  for (const invoice of invoices) {
    if (outstandingPence(invoice) === 0) continue;

    const key = invoice.accountId ?? invoice.clientId ?? 'unassigned';
    const name =
      invoice.account?.name ?? invoice.client?.name ?? 'No recipient recorded';

    const existing = groups.get(key);
    if (existing) {
      existing.invoices.push(invoice);
    } else {
      groups.set(key, {
        row: {
          clientId: invoice.clientId,
          accountId: invoice.accountId,
          name,
          buckets: ageInvoices([], now),
        },
        invoices: [invoice],
      });
    }
  }

  const rows: AgingRow[] = [];
  for (const { row, invoices: group } of groups.values()) {
    rows.push({ ...row, buckets: ageInvoices(group, now) });
  }

  // Worst first: the biggest debt is the one to act on.
  rows.sort((a, b) => b.buckets.total - a.buckets.total);

  return {
    rows,
    totals: ageInvoices(invoices, now),
  };
}

export async function getInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true, billingEmail: true, contactEmail: true } },
      account: { select: { id: true, name: true, billingEmail: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: {
          job: { select: { id: true, reference: true, scheduledAt: true } },
          rental: { select: { id: true, reference: true } },
        },
      },
      payments: { orderBy: { receivedAt: 'desc' } },
    },
  });
}

/**
 * The whole filtered ledger, for the spreadsheet.
 *
 * Unpaginated on purpose — an export that stopped at page one would be the
 * kind of quietly-wrong figure this ledger exists to replace. Capped so a
 * mis-typed filter cannot try to serialise the entire history at once.
 */
export async function invoicesForExport(
  filters: InvoiceFilters,
  now: Date = new Date(),
) {
  const rows = await prisma.invoice.findMany({
    where: buildInvoiceWhere(filters, now),
    orderBy: { issueDate: 'asc' },
    select: LIST_SELECT,
    take: 10_000,
  });

  return rows.map((row) => ({ ...row, outstandingPence: outstandingPence(row) }));
}

/** Rows for the spreadsheet export, already human-readable. */
export function toLedgerExportRows(
  rows: Array<{
    number: string;
    issueDate: Date;
    dueDate: Date;
    client: { name: string } | null;
    account: { name: string } | null;
    netPence: number;
    vatPence: number;
    grossPence: number;
    paidPence: number;
    outstandingPence: number;
    status: string;
  }>,
) {
  return rows.map((row) => ({
    Number: row.number,
    Issued: row.issueDate.toISOString().slice(0, 10),
    Due: row.dueDate.toISOString().slice(0, 10),
    Recipient: row.account?.name ?? row.client?.name ?? '',
    Net: row.netPence / 100,
    VAT: row.vatPence / 100,
    Gross: row.grossPence / 100,
    Paid: row.paidPence / 100,
    Outstanding: row.outstandingPence / 100,
    Status: row.status,
  }));
}

/**
 * The aging report as spreadsheet rows.
 *
 * Column order follows `AGING_LABELS` so the sheet reads left to right in the
 * same order as the screen, and a bucket added later cannot appear in one and
 * not the other.
 */
export function toAgingExportRows(rows: AgingRow[]) {
  return rows.map((row) => {
    const record: Record<string, string | number> = { 'Billed to': row.name };
    for (const { key, label } of AGING_LABELS) {
      record[label] = row.buckets[key] / 100;
    }
    record.Total = row.buckets.total / 100;
    return record;
  });
}
