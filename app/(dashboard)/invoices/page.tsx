import { Download, Plus } from 'lucide-react';
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
import { formatDate } from '@/lib/dates';
import { listInvoices } from '@/lib/invoice-list';
import { daysOverdue } from '@/lib/invoices';
import {
  filterFlag,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Invoices' };

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'PART_PAID', label: 'Part paid' },
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  DRAFT: 'secondary',
  SENT: 'default',
  PART_PAID: 'warning',
  OVERDUE: 'destructive',
  PAID: 'success',
  CANCELLED: 'secondary',
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const params = await searchParams;

  const listParams = parseListParams(params, { defaultSort: 'issueDate' });
  const filters = {
    status: filterValue(params, 'status'),
    clientId: filterValue(params, 'clientId'),
    accountId: filterValue(params, 'accountId'),
    from: toDate(filterValue(params, 'from')),
    to: toDate(filterValue(params, 'to')),
    overdueOnly: filterFlag(params, 'overdue'),
  };

  const { rows, total, totals } = await listInvoices(listParams, filters);
  const isFiltered = Boolean(
    filters.status || filters.from || filters.to || filters.overdueOnly,
  );

  return (
    <>
      <PageHeader
        title="Invoices"
        description="What has been billed, and what is still outstanding. The legacy system generated invoices and then lost track of them — this is the fix."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/invoices/aging">Aging</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/api/invoices/export?${new URLSearchParams(
                Object.entries(params).flatMap(([key, value]) =>
                  typeof value === 'string' ? [[key, value] as [string, string]] : [],
                ),
              ).toString()}`}>
                <Download aria-hidden />
                Export
              </Link>
            </Button>
            {can(user, 'editInvoices') ? (
              <Button asChild>
                <Link href="/invoices/new">
                  <Plus aria-hidden />
                  New invoice
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Totals across the whole filter, not this page. A total covering only
          page one would look authoritative and be wrong. */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Tile label="Invoiced" value={formatGBP(totals.invoicedPence)} hint={`${totals.count} invoice${totals.count === 1 ? '' : 's'}`} />
        <Tile label="Paid" value={formatGBP(totals.paidPence)} />
        <Tile
          label="Outstanding"
          value={formatGBP(totals.outstandingPence)}
          tone={totals.outstandingPence > 0 ? 'warning' : undefined}
        />
      </div>

      <ListToolbar
        action="/invoices"
        searchParams={params}
        searchPlaceholder="Search invoice number"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: STATUSES,
            allLabel: 'Any status',
          },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No invoices match those filters' : 'No invoices yet'}
          description={
            isFiltered
              ? 'Try widening the range, or clear the filters.'
              : 'Raise one from completed jobs and hires that have not been billed.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/invoices">Clear filters</Link>
              </Button>
            ) : can(user, 'editInvoices') ? (
              <Button asChild>
                <Link href="/invoices/new">
                  <Plus aria-hidden />
                  New invoice
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((invoice) => {
              const late =
                invoice.outstandingPence > 0 && daysOverdue(invoice.dueDate) > 0;
              return (
                <TableRow
                  key={invoice.id}
                  className={cn(late ? 'bg-destructive/5' : '')}
                >
                  <TableCell>
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="font-medium tabular hover:underline"
                    >
                      {invoice.number}
                    </Link>
                    {invoice.creditsInvoiceId ? (
                      <Badge variant="secondary" className="ml-2">
                        Credit note
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {invoice.account?.name ?? invoice.client?.name ?? '—'}
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {formatDate(invoice.issueDate)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'tabular',
                      late ? 'font-medium text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {formatDate(invoice.dueDate)}
                    {late ? (
                      <span className="ml-1 text-xs">
                        {daysOverdue(invoice.dueDate)}d
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {formatGBP(invoice.netPence)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatGBP(invoice.grossPence)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular',
                      invoice.outstandingPence > 0 ? 'font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {formatGBP(invoice.outstandingPence)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[invoice.status] ?? 'secondary'}>
                      {STATUSES.find((s) => s.value === invoice.status)?.label ??
                        invoice.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/invoices"
        searchParams={params}
        params={listParams}
        total={total}
        noun="invoice"
      />
    </>
  );
}

function toDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
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
  tone?: 'warning';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular',
            tone === 'warning' ? 'text-warning-foreground' : '',
          )}
        >
          {value}
        </p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
