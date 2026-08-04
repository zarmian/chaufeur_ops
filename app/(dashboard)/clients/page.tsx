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
import { listClients } from '@/lib/clients';
import {
  filterFlag,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';

export const metadata = { title: 'Clients' };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;

  const listParams = parseListParams(params, { defaultSort: 'name' });
  const filters = {
    archived: filterFlag(params, 'archived'),
    accountId: filterValue(params, 'accountId'),
  };

  const [{ rows, total }, accounts] = await Promise.all([
    listClients(listParams, filters),
    prisma.account.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const mayEdit = can(user, 'editClients');
  const isFiltered = Boolean(
    listParams.q || filters.accountId || filters.archived,
  );

  return (
    <>
      <PageHeader
        title="Clients"
        description="The people who ride. The account that books and pays for them is separate."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/clients/new">
                <Plus aria-hidden />
                New client
              </Link>
            </Button>
          ) : null
        }
      />

      <ListToolbar
        action="/clients"
        searchParams={params}
        searchPlaceholder="Search name, phone or email"
        filters={[
          {
            name: 'accountId',
            label: 'Account',
            options: accounts.map((a) => ({ value: a.id, label: a.name })),
            allLabel: 'Any account',
          },
          {
            name: 'archived',
            label: 'Show',
            options: [{ value: 'true', label: 'Archived only' }],
            allLabel: 'Active',
          },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={
            isFiltered ? 'No clients match those filters' : 'No clients yet'
          }
          description={
            isFiltered
              ? 'Try widening the search, or clear the filters to see everyone.'
              : 'Add clients as bookings come in, or load an existing list with the CSV import in Phase 3.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/clients">Clear filters</Link>
              </Button>
            ) : mayEdit ? (
              <Button asChild>
                <Link href="/clients/new">
                  <Plus aria-hidden />
                  New client
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Jobs</TableHead>
              <TableHead className="text-right">Terms</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((client) => (
              <TableRow key={client.id}>
                <TableCell>
                  <Link
                    href={`/clients/${client.id}`}
                    className="font-medium hover:underline"
                  >
                    {client.name}
                  </Link>
                  {client.deletedAt ? (
                    <Badge variant="secondary" className="ml-2">
                      Archived
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {client.contactPhone ?? client.contactEmail ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {client.defaultAccount?.name ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular">
                  {client._count.jobs}
                </TableCell>
                <TableCell className="text-right tabular text-muted-foreground">
                  {client.paymentTermsDays} days
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/clients"
        searchParams={params}
        params={listParams}
        total={total}
        noun="client"
      />
    </>
  );
}
