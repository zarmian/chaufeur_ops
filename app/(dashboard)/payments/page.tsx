import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/dates';
import { listPayments } from '@/lib/gateways/store';
import {
  filterValue,
  parseListParams,
  type SearchParams,
} from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Payments' };

/**
 * Every payment, with the invoice it belongs to — spec 4.7.6.
 *
 * Gateway transactions and hand-typed ones in one list, because the question
 * an operator asks is "did that money arrive", not "which system recorded
 * it". The gateway column answers the second when it matters.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('viewInvoices');
  const params = await searchParams;

  const listParams = parseListParams(params, { defaultSort: 'receivedAt' });
  const gateway = filterValue(params, 'gateway');

  const { rows, total, totalPence } = await listPayments(
    { skip: listParams.skip, take: listParams.take },
    { gateway },
  );

  return (
    <>
      <PageHeader
        title="Payments"
        description="What has come in, and against which invoice."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Received</p>
            <p className="mt-1 text-2xl font-semibold tabular">
              {formatGBP(totalPence)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {total} payment{total === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No payments recorded"
          description="They appear here as they are recorded against an invoice, whether by hand or by a gateway webhook."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Transaction</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell className="tabular text-muted-foreground">
                  {formatDate(payment.receivedAt)}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/invoices/${payment.invoice.id}`}
                    className="font-medium tabular hover:underline"
                  >
                    {payment.invoice.number}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {payment.invoice.account?.name ??
                    payment.invoice.client?.name ??
                    '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={payment.gateway === 'manual' ? 'secondary' : 'default'}>
                    {payment.gateway}
                  </Badge>
                </TableCell>
                <TableCell className="tabular text-xs text-muted-foreground">
                  {payment.gatewayTxnId ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular font-medium">
                  {formatGBP(payment.amountPence)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination
        basePath="/payments"
        searchParams={params}
        params={listParams}
        total={total}
        noun="payment"
      />
    </>
  );
}
