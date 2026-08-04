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
import { listAccounts } from '@/lib/accounts';
import { ACCOUNT_KINDS } from '@/lib/enum-options';
import { can } from '@/lib/authz';
import {
  filterFlag,
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const params = await searchParams;

  const listParams = parseListParams(params, { defaultSort: 'name' });
  const filters = {
    kind: filterValue(params, 'kind'),
    archived: filterFlag(params, 'archived'),
  };

  const { rows, total } = await listAccounts(listParams, filters);
  const mayEdit = can(user, 'editClients');
  const maySeeMoney = can(user, 'viewRevenue');
  const isFiltered = Boolean(listParams.q || filters.kind || filters.archived);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="The bookers who get invoiced. An account places the booking; the client rides."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link href="/accounts/new">
                <Plus aria-hidden />
                New account
              </Link>
            </Button>
          ) : null
        }
      />

      <ListToolbar
        action="/accounts"
        searchParams={params}
        searchPlaceholder="Search name or contact"
        filters={[
          {
            name: 'kind',
            label: 'Kind',
            options: ACCOUNT_KINDS.map((k) => ({ ...k })),
            allLabel: 'Any kind',
          },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No accounts match those filters' : 'No accounts yet'}
          description={
            isFiltered
              ? 'Try widening the search, or clear the filters.'
              : 'Add an account for your own brand, each partner agency, and any corporate client that books directly.'
          }
          action={
            isFiltered ? (
              <Button asChild variant="outline">
                <Link href="/accounts">Clear filters</Link>
              </Button>
            ) : mayEdit ? (
              <Button asChild>
                <Link href="/accounts/new">
                  <Plus aria-hidden />
                  New account
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
              <TableHead>Kind</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead className="text-right">Jobs</TableHead>
              {maySeeMoney ? (
                <TableHead className="text-right">This month</TableHead>
              ) : null}
              <TableHead className="text-right">Terms</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((account) => (
              <TableRow key={account.id}>
                <TableCell>
                  <Link
                    href={`/accounts/${account.id}`}
                    className="font-medium hover:underline"
                  >
                    {account.name}
                  </Link>
                  {!account.active ? (
                    <Badge variant="secondary" className="ml-2">
                      Inactive
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="capitalize text-muted-foreground">
                  {account.kind.toLowerCase()}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {account.contactName ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular">
                  {account._count.jobs}
                </TableCell>
                {maySeeMoney ? (
                  <TableCell className="text-right tabular">
                    {formatGBP(account.monthRevenuePence)}
                  </TableCell>
                ) : null}
                <TableCell className="text-right tabular text-muted-foreground">
                  {account.paymentTermsDays} days
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/accounts"
        searchParams={params}
        params={listParams}
        total={total}
        noun="account"
      />
    </>
  );
}
