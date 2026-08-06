import { Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { JobStatusBadge } from '@/components/job-status-badge';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { UnpricedBadge } from '@/components/unpriced-badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/authz';
import { formatDateTime, toDateOnlyString } from '@/lib/dates';
import { JOB_STATUSES, JOB_TYPES } from '@/lib/enum-options';
import { hasPriceOrReason } from '@/lib/job-status';
import { listJobs } from '@/lib/jobs';
import {
  filterFlag,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP, marginPct } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { BACKGROUND_THRESHOLD } from '@/lib/bulk';
import { prisma } from '@/lib/prisma';
import {
  bulkAssignAction,
  bulkInvoiceAction,
  bulkPriceAction,
  bulkTransitionAction,
} from './actions';
import {
  BulkActionBar,
  BulkSelectionProvider,
  JobRowCheckbox,
  JobSelectAllHeader,
} from './bulk-actions';
import { SortableHeader } from './sortable-header';

export const metadata = { title: 'Jobs' };

/**
 * The default window is today plus the next seven days (spec 2.2.9).
 *
 * Opening on all history is what made the legacy Overview slow and useless:
 * 704 rows, most of them irrelevant to what anyone was doing that morning.
 */
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const week = new Date();
  week.setDate(week.getDate() + 7);
  return { from: toDateOnlyString(today), to: toDateOnlyString(week) };
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;

  const listParams = parseListParams(params, {
    defaultSort: 'scheduledAt',
    defaultDir: 'asc',
  });

  // `all=true` opts out of the default window, rather than the window quietly
  // disappearing whenever the URL happens to carry no dates.
  const showAll = filterFlag(params, 'all');
  const range = defaultRange();
  const explicitFrom = filterValue(params, 'from');
  const explicitTo = filterValue(params, 'to');

  const filters = {
    status: filterValue(params, 'status'),
    jobType: filterValue(params, 'jobType'),
    driverId: filterValue(params, 'driverId'),
    clientId: filterValue(params, 'clientId'),
    accountId: filterValue(params, 'accountId'),
    vehicleId: filterValue(params, 'vehicleId'),
    from: explicitFrom ?? (showAll ? null : range.from),
    to: explicitTo ?? (showAll ? null : range.to),
    unpricedOnly: filterFlag(params, 'unpriced'),
  };

  const [{ rows, total, unpriced }, drivers, draftInvoices] = await Promise.all([
    listJobs(listParams, filters),
    prisma.driver.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 300,
    }),
    // Spec 6.5.2. Drafts only — an invoice that has been sent is immutable,
    // and changing one takes a credit note rather than another line.
    prisma.invoice.findMany({
      where: { status: 'DRAFT' },
      select: {
        id: true,
        number: true,
        client: { select: { name: true } },
        account: { select: { name: true } },
      },
      orderBy: { issueDate: 'desc' },
      take: 50,
    }),
  ]);

  const mayEdit = can(user, 'editJobs');
  const mayPrice = can(user, 'editJobFinances');
  const mayInvoice = can(user, 'editInvoices');
  const jobIds = rows.map((row) => row.id);
  const isFiltered = Boolean(
    listParams.q ||
      filters.status ||
      filters.jobType ||
      filters.driverId ||
      filters.unpricedOnly ||
      explicitFrom ||
      explicitTo,
  );

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Every booking, with the price captured at the point it was taken."
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Spec 6.3.7. Here rather than in the sidebar: a recurrence is a
                way of making jobs, so the place to look for one is the job
                list. */}
            <Button asChild variant="outline">
              <Link href="/jobs/series">Recurring</Link>
            </Button>
            {mayEdit ? (
              <Button asChild>
                <Link href="/jobs/new">
                  <Plus aria-hidden />
                  New job
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <ListToolbar
        action="/jobs"
        searchParams={params}
        searchPlaceholder="Search reference, client, driver, pickup or dropoff"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: JOB_STATUSES.map((s) => ({ ...s })),
            allLabel: 'Any status',
          },
          {
            name: 'jobType',
            label: 'Type',
            options: JOB_TYPES.map((t) => ({ ...t })),
            allLabel: 'Any type',
          },
          {
            name: 'driverId',
            label: 'Driver',
            options: drivers.map((d) => ({ value: d.id, label: d.name })),
            allLabel: 'Any driver',
          },
        ]}
      >
        <div className="flex items-end gap-3">
          <div>
            <label htmlFor="from" className="mb-1.5 block text-sm font-medium">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={filters.from ?? ''}
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            />
          </div>
          <div>
            <label htmlFor="to" className="mb-1.5 block text-sm font-medium">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={filters.to ?? ''}
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="unpriced"
              value="true"
              defaultChecked={filters.unpricedOnly}
              className="size-4 rounded border-input"
            />
            Unpriced only
          </label>
        </div>
      </ListToolbar>

      {rows.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No jobs match those filters' : 'No jobs in this window'}
          description={
            isFiltered
              ? 'Try widening the dates, or clear the filters.'
              : 'The list shows today and the next seven days. Book a job, or widen the dates to see history.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/jobs">Clear filters</Link>
              </Button>
            ) : mayEdit ? (
              <Button asChild>
                <Link href="/jobs/new">
                  <Plus aria-hidden />
                  New job
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <BulkSelectionProvider>
          <BulkActionBar
            priceAction={bulkPriceAction}
            transitionAction={bulkTransitionAction}
            assignAction={mayEdit ? bulkAssignAction : undefined}
            invoiceAction={mayInvoice ? bulkInvoiceAction : undefined}
            mayPrice={mayPrice}
            mayTransition={mayEdit}
            drivers={drivers.map((driver) => ({
              id: driver.id,
              label: driver.name,
            }))}
            draftInvoices={draftInvoices.map((invoice) => ({
              id: invoice.id,
              label: `${invoice.number} — ${
                invoice.client?.name ?? invoice.account?.name ?? 'No recipient'
              }`,
            }))}
            backgroundThreshold={BACKGROUND_THRESHOLD}
          />
          <div className="overflow-x-auto">
            <Table>
            <TableHeader>
              <TableRow>
                {mayEdit || mayPrice ? <JobSelectAllHeader jobIds={jobIds} /> : null}
                <SortableHeader sort="reference" searchParams={params}>
                  Reference
                </SortableHeader>
                <SortableHeader sort="scheduledAt" searchParams={params}>
                  Pickup time
                </SortableHeader>
                <TableHead>Route</TableHead>
                <SortableHeader sort="client" searchParams={params}>
                  Client
                </SortableHeader>
                <SortableHeader sort="driver" searchParams={params}>
                  Driver
                </SortableHeader>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Client price</TableHead>
                <SortableHeader sort="grossProfit" searchParams={params} align="right">
                  Gross profit
                </SortableHeader>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((job) => {
                const priced = hasPriceOrReason(job);
                const revenue =
                  job.finance?.totalClientPence ?? job.clientPricePence ?? 0;
                const profit = job.finance?.grossProfitPence ?? null;
                const margin = profit === null ? null : marginPct(revenue, profit);

                return (
                  <TableRow key={job.id}>
                    {mayEdit || mayPrice ? (
                      <JobRowCheckbox jobId={job.id} label={job.reference} />
                    ) : null}
                    <TableCell>
                      <Link
                        href={`/jobs/${job.id}`}
                        className="font-medium tabular hover:underline"
                      >
                        {job.reference}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap">
                      {formatDateTime(job.scheduledAt)}
                    </TableCell>
                    <TableCell className="max-w-72 text-muted-foreground">
                      <span className="block truncate">
                        {job.pickupText} → {job.dropoffText}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.client?.name ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.driver?.name ?? <span className="italic">Unassigned</span>}
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {priced ? formatGBP(job.clientPricePence ?? 0) : <UnpricedBadge />}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {profit === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={profit < 0 ? 'text-destructive' : undefined}>
                          {formatGBP(profit)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {margin === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={margin < 0 ? 'text-destructive' : undefined}>
                          {margin.toFixed(1)}%
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            </Table>
          </div>
        </BulkSelectionProvider>
      )}

      <Pagination
        basePath="/jobs"
        searchParams={params}
        params={listParams}
        total={total}
        noun="job"
        extra={
          unpriced > 0 ? (
            <Link href="/jobs?unpriced=true&all=true" className="hover:underline">
              <span className="font-medium text-destructive">{unpriced} unpriced</span>
            </Link>
          ) : null
        }
      />
    </>
  );
}
