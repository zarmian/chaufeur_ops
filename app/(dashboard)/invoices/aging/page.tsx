import { ArrowLeft, Download } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { agingReport } from '@/lib/invoice-list';
import { AGING_LABELS } from '@/lib/invoices';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Aging' };

/**
 * Who owes what, and how late.
 *
 * Bucketed by days past the *due date* rather than days since issue — an
 * invoice on 60-day terms is not overdue on day 31, and a report that says it
 * is stops being read. Worst debt first, because that is the call to make.
 */
export default async function AgingPage() {
  await pageRequireCapability('viewInvoices');

  const { rows, totals } = await agingReport();

  return (
    <>
      <PageHeader
        title="Aging"
        description="Outstanding balances by whoever is being billed, bucketed by how far past due they are."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/api/invoices/export?report=aging">
                <Download aria-hidden />
                Export
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/invoices">
                <ArrowLeft aria-hidden />
                Ledger
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {AGING_LABELS.map(({ key, label }) => (
          <Card key={key}>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p
                className={cn(
                  'mt-1 text-xl font-semibold tabular',
                  key === 'older' && totals.older > 0 ? 'text-destructive' : '',
                )}
              >
                {formatGBP(totals[key])}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing outstanding"
          description="Every sent invoice has been settled. Drafts and cancelled invoices are not counted here."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Billed to</TableHead>
              {AGING_LABELS.map(({ key, label }) => (
                <TableHead key={key} className="text-right">
                  {label}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.accountId ?? ''}-${row.clientId ?? ''}`}>
                <TableCell className="font-medium">
                  {row.accountId ? (
                    <Link
                      href={`/accounts/${row.accountId}`}
                      className="hover:underline"
                    >
                      {row.name}
                    </Link>
                  ) : row.clientId ? (
                    <Link
                      href={`/clients/${row.clientId}`}
                      className="hover:underline"
                    >
                      {row.name}
                    </Link>
                  ) : (
                    row.name
                  )}
                </TableCell>
                {AGING_LABELS.map(({ key }) => (
                  <TableCell
                    key={key}
                    className={cn(
                      'text-right tabular',
                      row.buckets[key] === 0
                        ? 'text-muted-foreground'
                        : key === 'older' || key === 'days90'
                          ? 'font-medium text-destructive'
                          : '',
                    )}
                  >
                    {row.buckets[key] === 0 ? '—' : formatGBP(row.buckets[key])}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular font-semibold">
                  {formatGBP(row.buckets.total)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2">
              <TableCell className="font-semibold">Total</TableCell>
              {AGING_LABELS.map(({ key }) => (
                <TableCell key={key} className="text-right tabular font-semibold">
                  {formatGBP(totals[key])}
                </TableCell>
              ))}
              <TableCell className="text-right tabular font-semibold">
                {formatGBP(totals.total)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </>
  );
}
