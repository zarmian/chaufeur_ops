import { AlertTriangle, Download } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TrendChart } from '@/components/trend-chart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { JOB_TYPES } from '@/lib/enum-options';
import {
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import {
  reportBreakdown,
  reportDetail,
  reportSummary,
  reportTrend,
  type Dimension,
} from '@/lib/reports';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Reports' };

const DIMENSIONS: Array<{ value: Dimension; label: string }> = [
  { value: 'jobType', label: 'Job type' },
  { value: 'client', label: 'Client' },
  { value: 'account', label: 'Account' },
  { value: 'driver', label: 'Driver' },
  { value: 'vehicle', label: 'Vehicle' },
];

const STATUSES = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'NO_SHOW', label: 'No show' },
];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('viewReports');
  const params = await searchParams;

  const fallback = lastTwelveMonths();
  const from = parseDate(filterValue(params, 'from')) ?? fallback.from;
  const to = parseDate(filterValue(params, 'to'), true) ?? fallback.to;

  const filters = {
    from,
    to,
    driverId: filterValue(params, 'driverId'),
    clientId: filterValue(params, 'clientId'),
    accountId: filterValue(params, 'accountId'),
    vehicleId: filterValue(params, 'vehicleId'),
    jobType: filterValue(params, 'jobType'),
    status: filterValue(params, 'status'),
  };

  const dimension: Dimension =
    DIMENSIONS.find((option) => option.value === filterValue(params, 'by'))
      ?.value ?? 'client';

  const listParams = parseListParams(params, { defaultSort: 'scheduledAt' });

  const [summary, breakdown, trend, detail, options] = await Promise.all([
    reportSummary(filters),
    reportBreakdown(filters, dimension),
    reportTrend(filters),
    reportDetail(filters, { skip: listParams.skip, take: listParams.take }),
    loadFilterOptions(),
  ]);

  const exportQuery = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value] as [string, string]] : [],
    ),
  );
  exportQuery.set('from', toDateOnlyString(from));
  exportQuery.set('to', toDateOnlyString(to));
  exportQuery.set('by', dimension);

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${formatDate(from)} — ${formatDate(to)}. Cancelled work is left out unless you ask for it.`}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <a href={`/api/reports/export?${exportQuery.toString()}`}>
                <Download aria-hidden />
                Excel
              </a>
            </Button>
            <Button asChild variant="outline">
              <a
                href={`/api/reports/pdf?${exportQuery.toString()}`}
                target="_blank"
                rel="noreferrer"
              >
                PDF
              </a>
            </Button>
          </div>
        }
      />

      <form
        method="get"
        action="/reports"
        className="mb-6 flex flex-wrap items-end gap-3"
        data-testid="report-filters"
      >
        <input type="hidden" name="by" value={dimension} />
        <Field id="from" label="From">
          <Input
            id="from"
            name="from"
            type="date"
            defaultValue={toDateOnlyString(from)}
          />
        </Field>
        <Field id="to" label="To">
          <Input id="to" name="to" type="date" defaultValue={toDateOnlyString(to)} />
        </Field>
        <Field id="driverId" label="Driver">
          <Select id="driverId" name="driverId" defaultValue={filters.driverId ?? ''}>
            <option value="">Any</option>
            {options.drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="clientId" label="Client">
          <Select id="clientId" name="clientId" defaultValue={filters.clientId ?? ''}>
            <option value="">Any</option>
            {options.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="accountId" label="Account">
          <Select id="accountId" name="accountId" defaultValue={filters.accountId ?? ''}>
            <option value="">Any</option>
            {options.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="vehicleId" label="Vehicle">
          <Select id="vehicleId" name="vehicleId" defaultValue={filters.vehicleId ?? ''}>
            <option value="">Any</option>
            {options.vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.registration}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="jobType" label="Type">
          <Select id="jobType" name="jobType" defaultValue={filters.jobType ?? ''}>
            <option value="">Any</option>
            {JOB_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="status" label="Status">
          <Select id="status" name="status" defaultValue={filters.status ?? ''}>
            <option value="">All but cancelled</option>
            {STATUSES.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Button asChild variant="ghost">
          <Link href="/reports">Reset</Link>
        </Button>
      </form>

      {/*
        Spec 4.6.3. The unpriced count sits in the same row as revenue, at the
        same size, because a revenue figure without it is misleading — the
        legacy system reported a year of jobs where almost all of them were
        worth £0, and nothing on the screen said so.
      */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile label="Jobs" value={String(summary.jobs)} />
        <Tile label="Revenue" value={formatGBP(summary.revenuePence)} />
        <Tile label="Costs" value={formatGBP(summary.costsPence)} />
        <Tile
          label="Gross profit"
          value={formatGBP(summary.profitPence)}
          tone={summary.profitPence < 0 ? 'bad' : undefined}
        />
        <Tile
          label="Margin"
          value={summary.marginPct === null ? '—' : `${summary.marginPct}%`}
          hint={summary.marginPct === null ? 'No revenue to measure' : undefined}
        />
        <Tile
          label="Unpriced"
          value={String(summary.unpricedJobs)}
          hint={
            summary.unpricedJobs > 0
              ? 'Counted in the job total, worth nothing in revenue'
              : 'Every job carries a price'
          }
          tone={summary.unpricedJobs > 0 ? 'warn' : undefined}
          icon={summary.unpricedJobs > 0}
        />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Month on month</CardTitle>
        </CardHeader>
        <CardContent>
          <TrendChart points={trend} />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-base">Breakdown</CardTitle>
          <div className="flex flex-wrap gap-1">
            {DIMENSIONS.map((option) => (
              <Button
                key={option.value}
                asChild
                size="sm"
                variant={option.value === dimension ? 'default' : 'ghost'}
              >
                <Link href={`/reports?${withParam(exportQuery, 'by', option.value)}`}>
                  {option.label}
                </Link>
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {breakdown.length === 0 ? (
            <EmptyState
              title="Nothing in this range"
              description="Widen the dates, or clear a filter."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Jobs</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {breakdown.map((row) => (
                  <TableRow key={`${row.id ?? 'none'}-${row.label}`}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">
                      {row.jobs}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatGBP(row.revenuePence)}
                    </TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">
                      {formatGBP(row.costsPence)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular',
                        row.profitPence < 0 ? 'font-medium text-destructive' : '',
                      )}
                    >
                      {formatGBP(row.profitPence)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular',
                        row.marginPct !== null && row.marginPct < 0
                          ? 'font-medium text-destructive'
                          : 'text-muted-foreground',
                      )}
                    >
                      {row.marginPct === null ? '—' : `${row.marginPct}%`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">The jobs behind it</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.rows.length === 0 ? (
            <EmptyState
              title="No jobs in this range"
              description="Widen the dates, or clear a filter."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link
                          href={`/jobs/${row.id}`}
                          className="font-medium tabular hover:underline"
                        >
                          {row.reference}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular text-muted-foreground">
                        {formatDate(row.scheduledAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.clientName ?? row.accountName ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.driverName ?? 'Unassigned'}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular',
                          row.revenuePence <= 0 ? 'text-warning-foreground' : '',
                        )}
                      >
                        {row.revenuePence <= 0
                          ? 'No price'
                          : formatGBP(row.revenuePence)}
                      </TableCell>
                      <TableCell className="text-right tabular text-muted-foreground">
                        {formatGBP(row.costsPence)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular',
                          row.profitPence < 0 ? 'font-medium text-destructive' : '',
                        )}
                      >
                        {formatGBP(row.profitPence)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <Pagination
            basePath="/reports"
            searchParams={params}
            params={listParams}
            total={detail.total}
            noun="job"
          />
        </CardContent>
      </Card>
    </>
  );
}

async function loadFilterOptions() {
  const [drivers, clients, accounts, vehicles] = await Promise.all([
    prisma.driver.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.client.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.account.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.vehicle.findMany({
      select: { id: true, registration: true },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
  ]);
  return { drivers, clients, accounts, vehicles };
}

function withParam(base: URLSearchParams, key: string, value: string): string {
  const next = new URLSearchParams(base);
  next.set(key, value);
  // Changing the breakdown returns to page one: staying on page 7 of a
  // different grouping is how a user concludes the data has gone.
  next.delete('page');
  return next.toString();
}

function parseDate(value: string | null, endOfDay = false): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
}

/** A year back, which is the range most questions about the business need. */
function lastTwelveMonths(): { from: Date; to: Date } {
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to };
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warn' | 'bad';
  icon?: boolean;
}) {
  return (
    <Card data-testid={`tile-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {icon ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
          {label}
        </p>
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular',
            tone === 'warn' ? 'text-warning-foreground' : '',
            tone === 'bad' ? 'text-destructive' : '',
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
