import { Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ListToolbar } from '@/components/list-toolbar';
import { renterName } from '@/lib/rentals';
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
import { listRentals } from '@/lib/rental-store';
import { RATE_TYPE_UNIT, RENTAL_STATUS_LABELS } from '@/lib/rentals';

export const metadata = { title: 'Rentals' };

const STATUS_OPTIONS = Object.entries(RENTAL_STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export default async function RentalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;
  const notice = filterValue(params, 'rentalNotice');
  const listParams = parseListParams(params);

  const filters = {
    status: filterValue(params, 'status'),
    vehicleId: filterValue(params, 'vehicleId'),
    driverId: filterValue(params, 'driverId'),
    arrearsOnly: filterFlag(params, 'arrears'),
  };

  const { rows, total } = await listRentals(listParams, filters);
  const mayEdit = can(user, 'editVehicles');
  const isFiltered = Boolean(filters.status || filters.arrearsOnly);

  return (
    <>
      <PageHeader
        title="Rentals"
        description="Company cars hired out. Revenue that never appears on a job."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/rentals/new">
                <Plus aria-hidden />
                New rental
              </Link>
            </Button>
          ) : null
        }
      />

      {/* The outcome of a delete, which happens on the detail page and lands
          here — there is nothing left to return to. */}
      {notice ? (
        <Alert className="mb-6" data-testid="rental-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <ListToolbar
        action="/rentals"
        searchParams={params}
        searchPlaceholder="Search"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: STATUS_OPTIONS,
            allLabel: 'Any status',
          },
        ]}
      >
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="arrears"
            value="true"
            defaultChecked={filters.arrearsOnly}
            className="size-4 rounded border-input"
          />
          Owing money only
        </label>
      </ListToolbar>

      {rows.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No rentals match those filters' : 'No rentals yet'}
          description={
            isFiltered
              ? 'Try clearing the filters.'
              : 'Hire a car out and it will appear here, with what is owed against it.'
          }
          action={
            mayEdit && !isFiltered ? (
              <Button asChild>
                <Link href="/rentals/new">
                  <Plus aria-hidden />
                  New rental
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
                <TableHead>Vehicle</TableHead>
                <TableHead>Renter</TableHead>
                <TableHead>Out</TableHead>
                <TableHead>Back</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Charge</TableHead>
                <TableHead className="text-right">Owing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((rental) => (
                <TableRow key={rental.id}>
                  <TableCell>
                    <Link
                      href={`/rentals/${rental.id}`}
                      className="font-medium tabular hover:underline"
                    >
                      {rental.reference}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular">
                    {rental.vehicle.registration}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {renterName(rental)}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {formatDateTime(rental.startAt)}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {formatDateTime(rental.returnedAt ?? rental.endAt)}
                    {rental.returnedAt ? '' : ' (due)'}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {formatGBP(rental.ratePence)}/{RATE_TYPE_UNIT[rental.rateType]}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        rental.status === 'ACTIVE'
                          ? 'warning'
                          : rental.status === 'RETURNED'
                            ? 'success'
                            : 'secondary'
                      }
                    >
                      {RENTAL_STATUS_LABELS[rental.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatGBP(rental.balance.totalPence)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {rental.balance.inArrears ? (
                      <span className="font-medium text-destructive">
                        {formatGBP(rental.balance.balancePence)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Settled</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pagination
        basePath="/rentals"
        searchParams={params}
        params={listParams}
        total={total}
        noun="rental"
      />
    </>
  );
}
