import { Download, Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  filterEnum,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { listPayouts } from '@/lib/payout-store';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Payouts' };

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PAID', label: 'Paid' },
];

const STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success'> = {
  DRAFT: 'secondary',
  APPROVED: 'warning',
  PAID: 'success',
};

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const params = await searchParams;

  const listParams = parseListParams(params, {
    defaultSort: 'periodStart',
    defaultDir: 'desc',
  });

  const filters = {
    driverId: filterValue(params, 'driverId'),
    status: filterEnum(params, 'status', STATUSES),
    from: toDate(filterValue(params, 'from')),
    to: toDate(filterValue(params, 'to')),
  };

  const { rows, total, totals } = await listPayouts(listParams, filters);
  const error = filterValue(params, 'payoutError');
  const isFiltered = Boolean(filters.status || filters.from || filters.to);

  return (
    <>
      <PageHeader
        title="Payouts"
        description="What is owed to drivers, and what has gone out. A job appears on one payout and only one."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/api/payouts/export">
                <Download aria-hidden />
                Export
              </Link>
            </Button>
            {can(user, 'editInvoices') ? (
              <Button asChild>
                <Link href="/payouts/new">
                  <Plus aria-hidden />
                  Generate
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="payout-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* Spec 4.5.7. Owed first, because it is the number somebody is about
          to move money against. */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Tile
          label="Owed to drivers"
          value={formatGBP(totals.owedPence)}
          hint="Drafted and approved, not yet paid"
          tone={totals.owedPence > 0 ? 'warning' : undefined}
        />
        <Tile
          label="Across this filter"
          value={formatGBP(totals.totalPence)}
          hint={`${total} payout${total === 1 ? '' : 's'}`}
        />
      </div>

      <ListToolbar
        action="/payouts"
        searchParams={params}
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
          title={isFiltered ? 'No payouts match those filters' : 'No payouts yet'}
          description={
            isFiltered
              ? 'Try widening the range, or clear the filters.'
              : 'Generate one for a period and every driver with unpaid work appears.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/payouts">Clear filters</Link>
              </Button>
            ) : can(user, 'editInvoices') ? (
              <Button asChild>
                <Link href="/payouts/new">
                  <Plus aria-hidden />
                  Generate
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Driver</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Paid</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((payout) => (
              <TableRow key={payout.id}>
                <TableCell>
                  <Link
                    href={`/payouts/${payout.id}`}
                    className="font-medium hover:underline"
                  >
                    {payout.driver.name}
                  </Link>
                  <span className="ml-2 text-xs tabular text-muted-foreground">
                    {payout.driver.reference}
                  </span>
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {formatDate(payout.periodStart)} — {formatDate(payout.periodEnd)}
                </TableCell>
                <TableCell className="text-right tabular text-muted-foreground">
                  {payout._count.lines}
                </TableCell>
                <TableCell className="text-right tabular font-medium">
                  {formatGBP(payout.totalPence)}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[payout.status] ?? 'secondary'}>
                    {STATUSES.find((s) => s.value === payout.status)?.label ??
                      payout.status}
                  </Badge>
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {payout.paidAt ? formatDate(payout.paidAt) : '—'}
                  {payout.paymentReference ? (
                    <span className="ml-1 text-xs">{payout.paymentReference}</span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/payouts"
        searchParams={params}
        params={listParams}
        total={total}
        noun="payout"
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
