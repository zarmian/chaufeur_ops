import { Download, Upload } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/authz';
import { TXN_KINDS } from '@/lib/bank/classify';
import { countsByKind, listTransactions } from '@/lib/bank/list';
import { formatDate } from '@/lib/dates';
import {
  buildListHref,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Reconciliation' };

const KIND_VARIANT: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  CLIENT_PAYMENT: 'success',
  RENTAL_INCOME: 'success',
  DRIVER_PAYOUT: 'default',
  FUEL: 'secondary',
  VEHICLE_COST: 'secondary',
  TRANSFER: 'secondary',
  UNCLASSIFIED: 'warning',
};

const KIND_LABEL = new Map(TXN_KINDS.map((kind) => [kind.value, kind.label]));

const STATES = [
  { value: 'unallocated', label: 'Not yet allocated' },
  { value: 'allocated', label: 'Allocated' },
];

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const params = await searchParams;

  const listParams = parseListParams(params, {
    defaultSort: 'occurredOn',
    defaultDir: 'desc',
  });
  const filters = {
    q: listParams.q,
    kind: filterValue(params, 'kind'),
    statementId: filterValue(params, 'statementId'),
    from: toDate(filterValue(params, 'from')),
    to: toDate(filterValue(params, 'to')),
    state: filterValue(params, 'state'),
  };

  const [{ rows, total, totals }, counts] = await Promise.all([
    listTransactions(listParams, filters),
    countsByKind(filters),
  ]);

  const isFiltered = Boolean(
    filters.q || filters.kind || filters.state || filters.from || filters.to,
  );

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="What the bank says happened, matched against what this system says was owed."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/reconciliation/rules">Rules</Link>
            </Button>
            <Button asChild variant="outline">
              <Link
                href={`/api/reconciliation/export?${new URLSearchParams(
                  Object.entries(params).flatMap(([key, value]) =>
                    typeof value === 'string' ? [[key, value] as [string, string]] : [],
                  ),
                ).toString()}`}
              >
                <Download aria-hidden />
                Export
              </Link>
            </Button>
            {can(user, 'editInvoices') ? (
              <Button asChild>
                <Link href="/reconciliation/import">
                  <Upload aria-hidden />
                  Import statement
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {/* The figure the screen exists for. Money that moved through the bank
          and that no invoice, payout or cost accounts for — the operator's
          question is whether the books are straight, and the answer is this
          reaching zero. Computed across the whole filter, not the page. */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Tile label="In" value={formatGBP(totals.inPence)} hint={`${totals.count} transaction${totals.count === 1 ? '' : 's'}`} />
        <Tile label="Out" value={formatGBP(totals.outPence)} />
        <Tile
          label="Unreconciled"
          value={formatGBP(totals.unreconciledPence)}
          hint={
            totals.unreconciledPence > 0
              ? `${formatGBP(totals.unreconciledInPence)} in, ${formatGBP(totals.unreconciledOutPence)} out`
              : 'Everything is accounted for'
          }
          tone={totals.unreconciledPence > 0 ? 'warning' : 'success'}
        />
      </div>

      {/* Counts before the click, because "how much is left to do" is the
          question and clicking through seven filters to find out is not an
          answer. */}
      <div className="mb-4 flex flex-wrap gap-2">
        {counts
          .filter((count) => count.count > 0)
          .map((count) => (
            <Button
              key={count.kind}
              asChild
              size="sm"
              variant={filters.kind === count.kind ? 'default' : 'outline'}
            >
              <Link
                href={buildListHref('/reconciliation', params, {
                  kind: filters.kind === count.kind ? null : count.kind,
                })}
              >
                {count.label}
                <span className="ml-1.5 tabular-nums opacity-70">{count.count}</span>
              </Link>
            </Button>
          ))}
      </div>

      <ListToolbar
        action="/reconciliation"
        searchParams={params}
        searchPlaceholder="Search description or reference"
        filters={[
          {
            name: 'state',
            label: 'State',
            options: STATES,
            allLabel: 'Any state',
          },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={
            isFiltered ? 'No transactions match those filters' : 'No statements imported yet'
          }
          description={
            isFiltered
              ? 'Try widening the range, or clear the filters.'
              : 'Upload a CSV from your bank. Nothing is written until you have seen what it would do.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/reconciliation">Clear filters</Link>
              </Button>
            ) : can(user, 'editInvoices') ? (
              <Button asChild>
                <Link href="/reconciliation/import">
                  <Upload aria-hidden />
                  Import statement
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Counterparty</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((txn) => {
              const counterparty =
                txn.account?.name ??
                txn.client?.name ??
                txn.driver?.name ??
                txn.vehicle?.registration ??
                null;

              return (
                <TableRow key={txn.id} className="cursor-pointer">
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/reconciliation/${txn.id}`} className="block">
                      {formatDate(txn.occurredOn)}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[22rem] truncate">
                    <Link href={`/reconciliation/${txn.id}`} className="block">
                      {txn.description}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {counterparty ?? '—'}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      txn.amountPence < 0 ? 'text-muted-foreground' : 'font-medium',
                    )}
                  >
                    {formatGBP(txn.amountPence)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={KIND_VARIANT[txn.kind] ?? 'secondary'}>
                      {KIND_LABEL.get(txn.kind) ?? txn.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {txn.allocatedAt ? (
                      <span className="text-sm text-muted-foreground">Allocated</span>
                    ) : (
                      <span className="text-sm font-medium">Outstanding</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/reconciliation"
        searchParams={params}
        params={listParams}
        total={total}
        noun="transaction"
      />
    </>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warning' | 'success';
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular-nums',
            tone === 'warning' && 'text-destructive',
          )}
        >
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function toDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}
