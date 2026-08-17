import { Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
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
import { describeWeekdays, listContracts } from '@/lib/contracts';
import { formatDate } from '@/lib/dates';
import { filterFlag, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Contracts' };

/**
 * Standing arrangements charged by the day.
 *
 * Separate from jobs because they are not bookings — they are the thing that
 * makes bookings. The days themselves live on the jobs list, like any other.
 */
export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;
  const includeEnded = filterFlag(params, 'ended');

  const rows = await listContracts({ includeEnded });
  const mayEdit = can(user, 'editJobs');

  return (
    <>
      <PageHeader
        title="Contracts"
        description="Standing arrangements charged by the day. A job is created for each day automatically, a couple of weeks ahead."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/contracts/new">
                <Plus aria-hidden />
                New contract
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-4">
        <Button asChild variant="outline" size="sm">
          <Link href={includeEnded ? '/contracts' : '/contracts?ended=true'}>
            {includeEnded ? 'Running only' : 'Show stopped ones too'}
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={includeEnded ? 'No contracts yet' : 'Nothing running'}
          description="A contract books the same run every day at an agreed day rate, without anybody entering it each morning."
          action={
            mayEdit ? (
              <Button asChild>
                <Link href="/contracts/new">New contract</Link>
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
                <TableHead>Contract</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead>Billed to</TableHead>
                <TableHead>Usual driver</TableHead>
                <TableHead className="text-right">Day rate</TableHead>
                <TableHead className="text-right">Days booked</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((contract) => (
                <TableRow key={contract.id} className={contract.active ? '' : 'opacity-60'}>
                  <TableCell>
                    <Link
                      href={`/contracts/${contract.id}`}
                      className="font-medium tabular hover:underline"
                    >
                      {contract.reference}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{contract.label}</span>
                    <span className="block max-w-72 truncate text-xs text-muted-foreground">
                      {contract.pickupText} → {contract.dropoffText}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {describeWeekdays(contract.weekdays)} at {contract.startTime}
                    <span className="block text-xs">
                      from {formatDate(contract.startsOn)}
                      {contract.endsOn ? ` to ${formatDate(contract.endsOn)}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contract.account?.name ?? contract.client?.name ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contract.driver?.name ?? (
                      <span className="italic">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatGBP(contract.dayRatePence)}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {contract._count.jobs}
                  </TableCell>
                  <TableCell>
                    <Badge variant={contract.active ? 'success' : 'secondary'}>
                      {contract.active ? 'Running' : 'Stopped'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
