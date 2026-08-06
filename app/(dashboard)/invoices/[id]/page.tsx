import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FileText,
  Plus,
  Printer,
  Trash2,
} from 'lucide-react';
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
import { getAllGatewayConfigs } from '@/lib/gateways/store';
import { gatewayUsable } from '@/lib/gateways/types';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { getInvoice } from '@/lib/invoice-list';
import { canEdit, daysOverdue, outstandingPence } from '@/lib/invoices';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Invoice' };

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const { id } = await params;
  const query = await searchParams;

  const [invoice, configured] = await Promise.all([
    getInvoice(id),
    getAllGatewayConfigs(),
  ]);
  if (!invoice) notFound();

  const gateways = configured.filter(gatewayUsable);
  const paymentLink = filterValue(query, 'paymentLink');

  const mayEdit = can(user, 'editInvoices');
  const editable = canEdit({ status: invoice.status });
  const outstanding = outstandingPence(invoice);
  const late = outstanding > 0 && daysOverdue(invoice.dueDate) > 0;
  const error = filterValue(query, 'invoiceError');
  const warning = filterValue(query, 'invoiceWarning');
  const notice = filterValue(query, 'invoiceNotice');

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={`${invoice.account?.name ?? invoice.client?.name ?? 'No recipient'} · issued ${formatDate(invoice.issueDate)}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={invoice.status === 'PAID' ? 'success' : 'secondary'}>
              {invoice.status.replace('_', ' ').toLowerCase()}
            </Badge>
            <Button asChild variant="outline">
              <a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer">
                <FileText aria-hidden />
                PDF
              </a>
            </Button>
            {/* The same document as HTML. It works on a deployment with no
                headless browser, and it is what you look at to check the
                letterhead before sending. */}
            <Button asChild variant="ghost">
              <a
                href={`/api/invoices/${invoice.id}/document`}
                target="_blank"
                rel="noreferrer"
              >
                <Printer aria-hidden />
                Print view
              </a>
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

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="invoice-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* Sending and emailing are different things, and the difference
          matters: an invoice can be sent without an email going out, and
          somebody has to know which happened. */}
      {notice ? (
        <Alert className="mb-6" data-testid="invoice-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {warning ? (
        <Alert className="mb-6" data-testid="invoice-warning">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}

      {/* The immutability rule, said before anyone tries to edit rather than
          after. It names the remedy, because "locked" alone leaves somebody
          with a wrong invoice and nothing to do about it. */}
      {!editable.ok ? (
        <Alert className="mb-6" data-testid="invoice-locked">
          <AlertDescription>{editable.message}</AlertDescription>
        </Alert>
      ) : null}

      {invoice.creditsInvoiceId ? (
        <Alert className="mb-6">
          <AlertDescription>
            This is a credit note. It reverses{' '}
            <Link
              href={`/invoices/${invoice.creditsInvoiceId}`}
              className="font-medium underline"
            >
              the original invoice
            </Link>
            , which keeps its own number and total.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lines</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Editable only while it is a draft. Once sent, the recipient
                  is holding a copy and the remedy is a credit note — so the
                  inputs are not merely disabled, they are not rendered. */}
              {mayEdit && editable.ok ? (
                <div className="space-y-2" data-testid="line-editor">
                  {invoice.lines.map((line, index) => (
                    <form
                      key={line.id}
                      method="post"
                      action={`/api/invoices/${invoice.id}/lines`}
                      className="flex flex-wrap items-center gap-2 rounded-md border p-2"
                    >
                      <input type="hidden" name="lineId" value={line.id} />
                      <Input
                        name="description"
                        defaultValue={line.description}
                        aria-label="Description"
                        className="min-w-48 flex-1"
                      />
                      <Input
                        name="amount"
                        inputMode="decimal"
                        defaultValue={(line.amountPence / 100).toFixed(2)}
                        aria-label="Amount"
                        className="w-28 text-right tabular"
                      />
                      <span className="w-24 shrink-0 text-xs tabular text-muted-foreground">
                        {line.job ? (
                          <Link href={`/jobs/${line.job.id}`} className="hover:underline">
                            {line.job.reference}
                          </Link>
                        ) : line.rental ? (
                          <Link
                            href={`/rentals/${line.rental.id}`}
                            className="hover:underline"
                          >
                            {line.rental.reference}
                          </Link>
                        ) : (
                          'Ad hoc'
                        )}
                      </span>
                      <Button type="submit" name="intent" value="update" variant="outline" size="sm">
                        Save
                      </Button>
                      {/* The direction rides on the button rather than a
                          hidden field: one form, two buttons, and only the
                          clicked one's value is submitted. */}
                      <Button
                        type="submit"
                        name="intent"
                        value="move:up"
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        aria-label="Move up"
                      >
                        <ChevronUp aria-hidden />
                      </Button>
                      <Button
                        type="submit"
                        name="intent"
                        value="move:down"
                        variant="ghost"
                        size="sm"
                        disabled={index === invoice.lines.length - 1}
                        aria-label="Move down"
                      >
                        <ChevronDown aria-hidden />
                      </Button>
                      <Button
                        type="submit"
                        name="intent"
                        value="remove"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove line"
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </form>
                  ))}

                  <form
                    method="post"
                    action={`/api/invoices/${invoice.id}/lines`}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2"
                    data-testid="add-line-form"
                  >
                    <input type="hidden" name="intent" value="add" />
                    <Input
                      name="description"
                      placeholder="Waiting time, parking, discount…"
                      aria-label="New line description"
                      className="min-w-48 flex-1"
                      required
                    />
                    <Input
                      name="amount"
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label="New line amount"
                      className="w-28 text-right tabular"
                      required
                    />
                    <Button type="submit" variant="outline" size="sm">
                      <Plus aria-hidden />
                      Add line
                    </Button>
                  </form>
                  <p className="text-xs text-muted-foreground">
                    A negative amount is a discount. Totals and VAT are
                    recomputed on every change.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoice.lines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>{line.description}</TableCell>
                        <TableCell className="tabular text-muted-foreground">
                          {line.job ? (
                            <Link
                              href={`/jobs/${line.job.id}`}
                              className="hover:underline"
                            >
                              {line.job.reference}
                            </Link>
                          ) : line.rental ? (
                            <Link
                              href={`/rentals/${line.rental.id}`}
                              className="hover:underline"
                            >
                              {line.rental.reference}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {formatGBP(line.amountPence)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <dl className="mt-4 space-y-1.5 border-t pt-4 text-sm">
                <Line label="Net" pence={invoice.netPence} />
                <Line
                  label={`VAT at ${Number(invoice.vatRatePct)}%`}
                  pence={invoice.vatPence}
                />
                <Line label="Gross" pence={invoice.grossPence} strong />
                <Line label="Paid" pence={invoice.paidPence} />
                <Line label="Outstanding" pence={outstanding} strong />
              </dl>
            </CardContent>
          </Card>

          {invoice.payments.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Payments</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {invoice.payments.map((payment) => (
                    <li
                      key={payment.id}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-muted-foreground">
                        {formatDate(payment.receivedAt)} · {payment.gateway}
                        {payment.gatewayTxnId ? ` · ${payment.gatewayTxnId}` : ''}
                      </span>
                      <span className="tabular">
                        {formatGBP(payment.amountPence)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Issued" value={formatDate(invoice.issueDate)} />
              <Row
                label="Due"
                value={`${formatDate(invoice.dueDate)}${late ? ` · ${daysOverdue(invoice.dueDate)} days overdue` : ''}`}
              />
              {invoice.sentAt ? (
                <Row label="Sent" value={formatDate(invoice.sentAt)} />
              ) : null}
              {invoice.paidAt ? (
                <Row label="Settled" value={formatDate(invoice.paidAt)} />
              ) : null}
            </CardContent>
          </Card>

          {mayEdit ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {invoice.status === 'DRAFT' ? (
                  <form method="post" action={`/api/invoices/${invoice.id}/actions`}>
                    <input type="hidden" name="intent" value="send" />
                    <Button type="submit" className="w-full">
                      Send invoice
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">
                      After this it cannot be edited — only credited. It is
                      emailed to the billing address if a provider is set up.
                    </p>
                  </form>
                ) : null}

                {invoice.status !== 'DRAFT' && outstanding > 0 ? (
                  <form
                    method="post"
                    action={`/api/invoices/${invoice.id}/actions`}
                    className="space-y-2"
                    data-testid="payment-form"
                  >
                    <input type="hidden" name="intent" value="payment" />
                    <label htmlFor="amount" className="block text-xs text-muted-foreground">
                      Record a payment
                    </label>
                    <Input
                      id="amount"
                      name="amount"
                      inputMode="decimal"
                      placeholder={(outstanding / 100).toFixed(2)}
                      required
                    />
                    <Input
                      name="receivedAt"
                      type="date"
                      defaultValue={toDateOnlyString(new Date())}
                    />
                    <Input name="reference" placeholder="Reference (optional)" />
                    <Button type="submit" variant="outline" className="w-full">
                      Record payment
                    </Button>
                  </form>
                ) : null}

                {/* Spec 4.7.3. Only when something is still owed and a
                    gateway is on — a link for nothing would confuse whoever
                    received it, and one for a gateway nobody enabled would
                    404 on the client's phone. */}
                {gateways.length > 0 && outstanding > 0 && invoice.status !== 'DRAFT' ? (
                  <form
                    method="post"
                    action={`/api/invoices/${invoice.id}/payment-link`}
                    className="space-y-2"
                    data-testid="payment-link-form"
                  >
                    <label className="block text-xs text-muted-foreground">
                      Payment link
                    </label>
                    {gateways.map((gateway) => (
                      <Button
                        key={gateway.name}
                        type="submit"
                        name="gateway"
                        value={gateway.name}
                        variant="outline"
                        className="w-full"
                      >
                        {gateway.name === 'revolut' ? 'Revolut' : 'SumUp'}
                        {gateway.environment === 'sandbox' ? ' (sandbox)' : ''}
                      </Button>
                    ))}
                  </form>
                ) : null}

                {paymentLink ? (
                  <div className="rounded-md border p-2" data-testid="payment-link">
                    <p className="text-xs text-muted-foreground">Send this to the client</p>
                    <a
                      href={paymentLink}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block break-all text-xs font-medium underline"
                    >
                      {paymentLink}
                    </a>
                  </div>
                ) : null}

                {invoice.status !== 'DRAFT' && !invoice.creditsInvoiceId ? (
                  <form method="post" action={`/api/invoices/${invoice.id}/actions`}>
                    <input type="hidden" name="intent" value="credit" />
                    <Button type="submit" variant="outline" className="w-full">
                      Raise a credit note
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">
                      A separate negative invoice referencing this one. This
                      invoice keeps its number and its total.
                    </p>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Line({
  label,
  pence,
  strong,
}: {
  label: string;
  pence: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd className={strong ? 'tabular font-semibold' : 'tabular'}>
        {formatGBP(pence)}
      </dd>
    </div>
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
