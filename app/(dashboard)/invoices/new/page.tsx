import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { formatDateTime, toDateOnlyString } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { billableFor } from '@/lib/revenue';
import { vatTreatmentLabel } from '@/lib/vat';
import { getLocaleConfig } from '@/lib/locale-store';
import { defaultPnlWindow, windowToInputs } from '@/lib/vehicle-pnl';

export const metadata = { title: 'New invoice' };

/**
 * Raise an invoice from what has not been billed.
 *
 * Jobs and hires in one list, because both are revenue and an operator
 * chasing money does not care which is which. Anything already on a live
 * invoice is shown greyed rather than hidden — "where did that job go" is a
 * worse question than "why is that one not selectable".
 */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('editInvoices');
  const query = await searchParams;

  const fallback = defaultPnlWindow();
  const inputs = windowToInputs({
    from: parseDate(filterValue(query, 'from')) ?? fallback.from,
    to: parseDate(filterValue(query, 'to')) ?? fallback.to,
  });

  const accountId = filterValue(query, 'accountId');
  const clientId = filterValue(query, 'clientId');

  const [accounts, clients, billable, locale] = await Promise.all([
    prisma.account.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.client.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    billableFor(
      {
        from: new Date(`${inputs.from}T00:00:00.000Z`),
        to: new Date(`${inputs.to}T23:59:59.999Z`),
      },
      {
        ...(accountId ? { accountId } : {}),
        ...(clientId ? { clientId } : {}),
      },
    ),
    getLocaleConfig(),
  ]);

  const taxName = locale.taxName;
  const selectable = billable.items.filter((item) => !item.alreadyInvoiced);
  const error = filterValue(query, 'invoiceError');

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Completed jobs and returned hires that have not been billed. Totals and VAT are computed when you raise it."
        actions={
          <Button asChild variant="outline">
            <Link href="/invoices">
              <ArrowLeft aria-hidden />
              Ledger
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="invoice-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form
        method="get"
        action="/invoices/new"
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-muted-foreground">
            From
          </label>
          <Input id="from" name="from" type="date" defaultValue={inputs.from} />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-muted-foreground">
            To
          </label>
          <Input id="to" name="to" type="date" defaultValue={inputs.to} />
        </div>
        <div>
          <label
            htmlFor="accountId"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Account
          </label>
          <Select id="accountId" name="accountId" defaultValue={accountId ?? ''}>
            <option value="">Any</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label
            htmlFor="clientId"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Client
          </label>
          <Select id="clientId" name="clientId" defaultValue={clientId ?? ''}>
            <option value="">Any</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
        {accountId || clientId ? (
          <p className="pb-2 text-xs text-muted-foreground">
            Hires are billed to the driver renting the car, so they are left out
            while a client or account filter is on.
          </p>
        ) : null}
      </form>

      {selectable.length === 0 ? (
        <EmptyState
          title="Nothing to bill in that period"
          description="Completed jobs and returned hires appear here once they are not already on a live invoice."
        />
      ) : (
        <form method="post" action="/api/invoices" data-testid="new-invoice-form">
          <input type="hidden" name="from" value={inputs.from} />
          <input type="hidden" name="to" value={inputs.to} />

          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <div>
              <label
                htmlFor="recipientAccountId"
                className="mb-1 block text-sm font-medium"
              >
                Bill to account
              </label>
              <Select
                id="recipientAccountId"
                name="accountId"
                defaultValue={accountId ?? ''}
              >
                <option value="">—</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label
                htmlFor="recipientClientId"
                className="mb-1 block text-sm font-medium"
              >
                …or to client
              </label>
              <Select
                id="recipientClientId"
                name="clientId"
                defaultValue={clientId ?? ''}
              >
                <option value="">—</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="issueDate" className="mb-1 block text-sm font-medium">
                Issue date
              </label>
              <Input
                id="issueDate"
                name="issueDate"
                type="date"
                defaultValue={toDateOnlyString(new Date())}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Due date follows the recipient&rsquo;s payment terms.
              </p>
            </div>
          </div>

          {/* The columns the jobs list uses. Choosing what to bill from a
              column of references alone meant opening each job in turn to
              find out what it was. */}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10"></TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Pickup time</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>{taxName}</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {billable.items.map((item) => (
                  <TableRow
                    key={`${item.kind}-${item.id}`}
                    className={item.alreadyInvoiced ? 'opacity-50' : ''}
                  >
                    <TableCell>
                      <input
                        type="checkbox"
                        name="item"
                        value={`${item.kind}:${item.id}`}
                        defaultChecked={!item.alreadyInvoiced}
                        disabled={item.alreadyInvoiced}
                        aria-label={`Include ${item.reference}`}
                        className="size-4"
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={
                          item.kind === 'JOB'
                            ? `/jobs/${item.id}`
                            : `/rentals/${item.id}`
                        }
                        className="font-medium tabular hover:underline"
                      >
                        {item.reference}
                      </Link>
                      {item.alreadyInvoiced ? (
                        <Badge variant="secondary" className="ml-2">
                          Already invoiced
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                      {formatDateTime(item.occurredAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{item.what}</TableCell>
                    <TableCell className="max-w-72 text-muted-foreground">
                      <span className="block truncate">{item.route}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.who ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.driverName ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {/* What this item will be taxed at, before it is
                          billed — the point at which it can still be
                          corrected on the job. */}
                      {vatTreatmentLabel(item.line.vatTreatment)}
                      {item.line.disbursementPence > 0 ? (
                        <span className="block text-xs">
                          {formatGBP(item.line.disbursementPence)} untaxed
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatGBP(item.amountPence)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t pt-4">
            <div className="text-sm">
              <span className="text-muted-foreground">Selected total, before VAT: </span>
              <span className="tabular font-semibold">
                {formatGBP(billable.totalPence)}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {billable.jobPence > 0
                  ? `${formatGBP(billable.jobPence)} jobs`
                  : ''}
                {billable.rentalPence > 0
                  ? `${billable.jobPence > 0 ? ' · ' : ''}${formatGBP(billable.rentalPence)} hire`
                  : ''}
              </span>
            </div>
            <Button type="submit">Raise draft invoice</Button>
          </div>
        </form>
      )}
    </>
  );
}

function parseDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}
