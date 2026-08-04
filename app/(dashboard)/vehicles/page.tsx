import { Plus } from 'lucide-react';
import Link from 'next/link';
import { ComplianceBadge } from '@/components/compliance-badge';
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
import { formatDate } from '@/lib/dates';
import {
  filterFlag,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getComplianceThresholds } from '@/lib/settings';
import { VEHICLE_CLASSES, VEHICLE_STATUSES } from '@/lib/enum-options';
import { listVehicles } from '@/lib/vehicles';

export const metadata = { title: 'Vehicles' };

const COMPLIANCE_OPTIONS = [
  { value: 'expired', label: 'Expired' },
  { value: 'unknown', label: 'No expiry recorded' },
  { value: 'critical', label: 'Expiring within 7 days' },
  { value: 'warning', label: 'Expiring within 30 days' },
  { value: 'ok', label: 'Compliant' },
];

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;

  const listParams = parseListParams(params, { defaultSort: 'registration' });
  const filters = {
    status: filterValue(params, 'status'),
    vehicleClass: filterValue(params, 'vehicleClass'),
    compliance: filterValue(params, 'compliance'),
    archived: filterFlag(params, 'archived'),
  };

  const thresholds = await getComplianceThresholds();
  const { rows, total } = await listVehicles(listParams, filters, thresholds);

  const mayEdit = can(user, 'editVehicles');
  const isFiltered = Boolean(
    listParams.q ||
      filters.status ||
      filters.vehicleClass ||
      filters.compliance ||
      filters.archived,
  );

  return (
    <>
      <PageHeader
        title="Vehicles"
        description="The fleet, and whether each car is legal to put on a job today."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/vehicles/new">
                <Plus aria-hidden />
                New vehicle
              </Link>
            </Button>
          ) : null
        }
      />

      <ListToolbar
        action="/vehicles"
        searchParams={params}
        searchPlaceholder="Search registration, make or model"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: VEHICLE_STATUSES.map((s) => ({ ...s })),
            allLabel: 'Any status',
          },
          {
            name: 'vehicleClass',
            label: 'Class',
            options: VEHICLE_CLASSES.map((c) => ({ ...c })),
            allLabel: 'Any class',
          },
          {
            name: 'compliance',
            label: 'Compliance',
            options: COMPLIANCE_OPTIONS,
            allLabel: 'Any state',
          },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={
            isFiltered ? 'No vehicles match those filters' : 'No vehicles yet'
          }
          description={
            isFiltered
              ? 'Try widening the search, or clear the filters.'
              : 'Add the fleet here, or load it in bulk with the CSV import in Phase 3.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/vehicles">Clear filters</Link>
              </Button>
            ) : mayEdit ? (
              <Button asChild>
                <Link href="/vehicles/new">
                  <Plus aria-hidden />
                  New vehicle
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Registration</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Compliance</TableHead>
              <TableHead>Next expiry</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((vehicle) => {
              // The soonest dated requirement, which is what the operator
              // actually has to act on next.
              const next = [...vehicle.compliance.items]
                .filter((i) => i.expiresOn)
                .sort(
                  (a, b) =>
                    (a.expiresOn?.getTime() ?? 0) - (b.expiresOn?.getTime() ?? 0),
                )[0];

              return (
                <TableRow key={vehicle.id}>
                  <TableCell>
                    <Link
                      href={`/vehicles/${vehicle.id}`}
                      className="font-medium tabular hover:underline"
                    >
                      {vehicle.registration}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {vehicle.make} {vehicle.model}
                    {vehicle.variant ? ` ${vehicle.variant}` : ''}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {vehicle.drivers.length === 0
                      ? '—'
                      : vehicle.drivers.map((d) => d.name).join(', ')}
                  </TableCell>
                  <TableCell>
                    <ComplianceBadge level={vehicle.compliance.level} />
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {next?.expiresOn
                      ? `${next.label} · ${formatDate(next.expiresOn)}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {vehicle.status === 'ACTIVE' ? (
                      <span className="text-muted-foreground">Active</span>
                    ) : (
                      <Badge variant="secondary">
                        {vehicle.status === 'OFF_ROAD' ? 'Off road' : 'Retired'}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/vehicles"
        searchParams={params}
        params={listParams}
        total={total}
        noun="vehicle"
      />
    </>
  );
}
