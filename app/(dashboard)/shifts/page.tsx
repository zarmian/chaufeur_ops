import { Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Badge } from '@/components/ui/badge';
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
import { formatDateTime } from '@/lib/dates';
import {
  filterFlag,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { listShifts } from '@/lib/shift-store';
import { formatShiftLength } from '@/lib/shifts';

export const metadata = { title: 'Shifts' };

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;
  const listParams = parseListParams(params);

  const filters = {
    driverId: filterValue(params, 'driverId'),
    openOnly: filterFlag(params, 'open'),
  };

  const { rows, total } = await listShifts(listParams, filters);
  const mayEdit = can(user, 'editDrivers');

  return (
    <>
      <PageHeader
        title="Shifts"
        description="Hired drivers are paid for time, not per job. A shift may cover several jobs, or none."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/shifts/new">
                <Plus aria-hidden />
                Start a shift
              </Link>
            </Button>
          ) : null
        }
      />

      <ListToolbar action="/shifts" searchParams={params} searchPlaceholder="Search">
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="open"
            value="true"
            defaultChecked={filters.openOnly}
            className="size-4 rounded border-input"
          />
          Still open only
        </label>
      </ListToolbar>

      {rows.length === 0 ? (
        <EmptyState
          title={filters.openOnly ? 'No open shifts' : 'No shifts yet'}
          description="Start a shift when a hired driver clocks on. Owner-drivers are paid per job and need none."
          action={
            mayEdit ? (
              <Button asChild>
                <Link href="/shifts/new">
                  <Plus aria-hidden />
                  Start a shift
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Length</TableHead>
                <TableHead className="text-right">Jobs</TableHead>
                <TableHead className="text-right">Pay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((shift) => (
                <TableRow key={shift.id}>
                  <TableCell>
                    <Link
                      href={`/shifts/${shift.id}`}
                      className="font-medium tabular hover:underline"
                    >
                      {shift.reference}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {shift.driver.name}
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {shift.vehicle?.registration ?? '—'}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {formatDateTime(shift.startedAt)}
                  </TableCell>
                  <TableCell>
                    {shift.endedAt ? (
                      <span className="tabular">{formatShiftLength(shift.minutes)}</span>
                    ) : (
                      <Badge variant="warning">Open</Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {shift._count.jobs}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {shift.payPence === null ? '—' : formatGBP(shift.payPence)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pagination
        basePath="/shifts"
        searchParams={params}
        params={listParams}
        total={total}
        noun="shift"
      />
    </>
  );
}
