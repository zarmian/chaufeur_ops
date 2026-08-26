import { Plus, Send } from 'lucide-react';
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
import { listDrivers } from '@/lib/drivers';
import { DRIVER_STATUSES } from '@/lib/enum-options';
import {
  filterFlag,
  filterEnum,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getComplianceThresholds } from '@/lib/settings';

export const metadata = { title: 'Drivers' };

const COMPLIANCE_OPTIONS = [
  { value: 'expired', label: 'Expired' },
  { value: 'unknown', label: 'No expiry recorded' },
  { value: 'critical', label: 'Expiring within 7 days' },
  { value: 'warning', label: 'Expiring within 30 days' },
  { value: 'ok', label: 'Compliant' },
];

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;

  const listParams = parseListParams(params, { defaultSort: 'name' });
  const filters = {
    status: filterEnum(params, 'status', DRIVER_STATUSES),
    compliance: filterValue(params, 'compliance'),
    archived: filterFlag(params, 'archived'),
  };

  const thresholds = await getComplianceThresholds();
  const { rows, total } = await listDrivers(listParams, filters, thresholds);

  const mayEdit = can(user, 'editDrivers');
  const isFiltered = Boolean(
    listParams.q || filters.status || filters.compliance || filters.archived,
  );

  const blocked = rows.filter((d) => !d.compliance.compliant).length;

  return (
    <>
      <PageHeader
        title="Drivers"
        description="Compliance spans the driver and the car they drive — a valid badge in an uninsured vehicle is still not a job that can go out."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/drivers/new">
                <Plus aria-hidden />
                New driver
              </Link>
            </Button>
          ) : null
        }
      />

      <ListToolbar
        action="/drivers"
        searchParams={params}
        searchPlaceholder="Search name, reference or phone"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: DRIVER_STATUSES.map((s) => ({ ...s })),
            allLabel: 'Any status',
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
          title={isFiltered ? 'No drivers match those filters' : 'No drivers yet'}
          description={
            isFiltered
              ? 'Try widening the search, or clear the filters.'
              : 'Add drivers here, or load them in bulk with the CSV import in Phase 3.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/drivers">Clear filters</Link>
              </Button>
            ) : mayEdit ? (
              <Button asChild>
                <Link href="/drivers/new">
                  <Plus aria-hidden />
                  New driver
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead>Compliance</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((driver) => (
              <TableRow key={driver.id}>
                <TableCell className="tabular text-muted-foreground">
                  {driver.reference}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/drivers/${driver.id}`}
                    className="font-medium hover:underline"
                  >
                    {driver.name}
                  </Link>
                  {driver.telegramChatId ? (
                    <Send
                      className="ml-1.5 inline size-3 text-muted-foreground"
                      aria-label="Linked to Telegram"
                    />
                  ) : null}
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {driver.phone}
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {driver.assignedVehicle?.registration ?? '—'}
                </TableCell>
                <TableCell>
                  <ComplianceBadge level={driver.compliance.level} />
                </TableCell>
                <TableCell>
                  {driver.status === 'ACTIVE' ? (
                    <span className="text-muted-foreground">Active</span>
                  ) : (
                    <Badge
                      variant={
                        driver.status === 'SUSPENDED' ? 'destructive' : 'secondary'
                      }
                    >
                      {driver.status === 'SUSPENDED' ? 'Suspended' : 'Inactive'}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/drivers"
        searchParams={params}
        params={listParams}
        total={total}
        noun="driver"
        extra={
          blocked > 0 ? (
            <span className="font-medium text-destructive">
              {blocked} on this page cannot be assigned
            </span>
          ) : null
        }
      />
    </>
  );
}
