import { ArrowLeft, FileText, Printer } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/authz';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { canEditPayout, getPayout } from '@/lib/payout-store';

export const metadata = { title: 'Payout' };

const STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success'> = {
  DRAFT: 'secondary',
  APPROVED: 'warning',
  PAID: 'success',
};

export default async function PayoutDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const { id } = await params;
  const query = await searchParams;

  const payout = await getPayout(id);
  if (!payout) notFound();

  const mayEdit = can(user, 'editInvoices');
  const error = filterValue(query, 'payoutError');
  const isDraft = canEditPayout(payout.status);

  return (
    <>
      <PageHeader
        title={payout.driver.name}
        description={`${formatDate(payout.periodStart)} — ${formatDate(payout.periodEnd)} · ${payout.driver.reference}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[payout.status] ?? 'secondary'}>
              {payout.status.toLowerCase()}
            </Badge>
            <Button asChild variant="outline">
              <a href={`/api/payouts/${payout.id}/pdf`} target="_blank" rel="noreferrer">
                <FileText aria-hidden />
                Statement
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a
                href={`/api/payouts/${payout.id}/document`}
                target="_blank"
                rel="noreferrer"
              >
                <Printer aria-hidden />
                Print view
              </a>
            </Button>
            <Button asChild variant="outline">
              <Link href="/payouts">
                <ArrowLeft aria-hidden />
                Payouts
              </Link>
            </Button>
          </div>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="payout-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lines</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payout.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="tabular text-muted-foreground">
                      {line.job
                        ? formatDate(line.job.scheduledAt)
                        : line.shift
                          ? formatDate(line.shift.startedAt)
                          : '—'}
                    </TableCell>
                    <TableCell>
                      {line.job ? (
                        <Link
                          href={`/jobs/${line.job.id}`}
                          className="hover:underline"
                        >
                          {line.description ?? line.job.reference}
                        </Link>
                      ) : line.shift ? (
                        <Link
                          href={`/shifts/${line.shift.id}`}
                          className="hover:underline"
                        >
                          {line.description ?? line.shift.reference}
                        </Link>
                      ) : (
                        (line.description ?? '—')
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {line.job
                        ? `${line.job.pickupText} → ${line.job.dropoffText}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatGBP(line.amountPence)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="mt-4 flex items-baseline justify-between border-t pt-4">
              <span className="font-medium">Total</span>
              <span className="tabular text-lg font-semibold">
                {formatGBP(payout.totalPence)}
              </span>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Settlement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Period" value={`${formatDate(payout.periodStart)} — ${formatDate(payout.periodEnd)}`} />
              <Row label="Lines" value={String(payout.lines.length)} />
              {payout.paidAt ? (
                <Row label="Paid" value={formatDate(payout.paidAt)} />
              ) : null}
              {payout.paymentReference ? (
                <Row label="Reference" value={payout.paymentReference} />
              ) : null}
            </CardContent>
          </Card>

          {mayEdit ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isDraft ? (
                  <>
                    <form method="post" action={`/api/payouts/${payout.id}/actions`}>
                      <input type="hidden" name="intent" value="approve" />
                      <Button type="submit" className="w-full">
                        Approve
                      </Button>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Approval is somebody saying the figures are right.
                        Paying is the bank, and the two are kept apart.
                      </p>
                    </form>
                    <form method="post" action={`/api/payouts/${payout.id}/actions`}>
                      <input type="hidden" name="intent" value="discard" />
                      <Button type="submit" variant="ghost" className="w-full">
                        Discard draft
                      </Button>
                    </form>
                  </>
                ) : null}

                {payout.status === 'APPROVED' ? (
                  <form
                    method="post"
                    action={`/api/payouts/${payout.id}/actions`}
                    className="space-y-2"
                    data-testid="pay-form"
                  >
                    <input type="hidden" name="intent" value="pay" />
                    <label
                      htmlFor="paidAt"
                      className="block text-xs text-muted-foreground"
                    >
                      Mark paid
                    </label>
                    <Input
                      id="paidAt"
                      name="paidAt"
                      type="date"
                      defaultValue={toDateOnlyString(new Date())}
                    />
                    <Input
                      name="paymentReference"
                      placeholder="Bank reference (optional)"
                    />
                    <Button type="submit" className="w-full">
                      Mark paid
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Every job on this payout flips to fully paid in the same
                      transaction.
                    </p>
                  </form>
                ) : null}

                {payout.status === 'PAID' ? (
                  <p className="text-xs text-muted-foreground" data-testid="payout-settled">
                    Settled. Every job on it reads as fully paid.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="tabular">{value}</p>
    </div>
  );
}
