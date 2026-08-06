import { ArrowLeft, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { can } from '@/lib/authz';
import { TXN_KINDS } from '@/lib/bank/classify';
import { getTransaction } from '@/lib/bank/list';
import { proposeFor } from '@/lib/bank/store';
import { formatDate } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';

export const metadata = { title: 'Transaction' };

const COST_KINDS = [
  'SERVICE',
  'REPAIR',
  'MOT_TEST',
  'TYRES',
  'BODYWORK',
  'CLEANING',
  'INSURANCE',
  'ROAD_TAX',
  'FINANCE',
  'LEASE',
  'BREAKDOWN_COVER',
  'PARKING_PERMIT',
  'OTHER',
];

export default async function TransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const { id } = await params;
  const query = await searchParams;

  const txn = await getTransaction(id);
  if (!txn) notFound();

  const proposal = await proposeFor(id);
  const error = filterValue(query, 'bankError');
  const editable = can(user, 'editInvoices');
  const action = `/api/reconciliation/${id}/actions`;

  // No driver picker: a payout debit takes its driver from the payout that is
  // chosen, so asking for one separately would let the two disagree.
  const [clients, accounts, vehicles] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
    prisma.account.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
    prisma.vehicle.findMany({
      select: { id: true, registration: true },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
  ]);

  return (
    <>
      <PageHeader
        title={txn.description || 'Transaction'}
        description={`${formatDate(txn.occurredOn)} · ${formatGBP(txn.amountPence)}${txn.bankRef ? ` · ${txn.bankRef}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/reconciliation">
                <ArrowLeft aria-hidden />
                Back
              </Link>
            </Button>
            {editable && txn.allocatedAt ? (
              <form method="post" action={action}>
                <input type="hidden" name="intent" value="undo" />
                <Button type="submit" variant="outline">
                  <Undo2 aria-hidden />
                  Undo
                </Button>
              </form>
            ) : null}
          </div>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="bank-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* What it was matched to, and why. A wrong classification has to be
              traceable back to the rule that made it, or the operator can
              only ever fix the symptom. */}
          <Card>
            <CardHeader>
              <CardTitle>What this is</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={txn.kind === 'UNCLASSIFIED' ? 'warning' : 'default'}>
                  {TXN_KINDS.find((k) => k.value === txn.kind)?.label ?? txn.kind}
                </Badge>
                {txn.allocatedAt ? (
                  <Badge variant="success">Allocated</Badge>
                ) : (
                  <Badge variant="secondary">Not yet allocated</Badge>
                )}
              </div>

              <p className="text-sm text-muted-foreground">
                {txn.rule
                  ? `Matched the rule “${txn.rule.phrase}”.`
                  : txn.matchedRuleId
                    ? 'Matched a rule that has since been deleted.'
                    : 'Classified by hand, or not matched by any rule.'}
              </p>

              {editable && !txn.allocatedAt ? (
                <form method="post" action={action} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="intent" value="classify" />
                  <div>
                    <label htmlFor="kind" className="mb-1 block text-sm font-medium">
                      Classification
                    </label>
                    <Select id="kind" name="kind" defaultValue={txn.kind} className="w-56">
                      {TXN_KINDS.map((kind) => (
                        <option key={kind.value} value={kind.value}>
                          {kind.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label htmlFor="accountId" className="mb-1 block text-sm font-medium">
                      Who
                    </label>
                    <Select
                      id="accountId"
                      name="accountId"
                      defaultValue={txn.accountId ?? 'none'}
                      className="w-56"
                    >
                      <option value="none">Nobody in particular</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label htmlFor="clientId" className="mb-1 block text-sm font-medium">
                      Or client
                    </label>
                    <Select
                      id="clientId"
                      name="clientId"
                      defaultValue={txn.clientId ?? 'none'}
                      className="w-56"
                    >
                      <option value="none">Nobody in particular</option>
                      {clients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button type="submit" variant="outline">
                    Save
                  </Button>
                </form>
              ) : null}
            </CardContent>
          </Card>

          {/* The proposal. Spec 4.8.3.4: exactly which invoices this would
              clear and what would be left part-paid, before anything is
              written. */}
          {proposal.kind === 'invoices' ? (
            <Card>
              <CardHeader>
                <CardTitle>What this would settle</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {formatGBP(txn.amountPence)} from {proposal.payerName}, oldest invoice
                  first.
                </p>

                {proposal.proposal.allocations.length === 0 ? (
                  <p className="text-sm">
                    Nothing outstanding for {proposal.payerName} to settle.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead className="text-right">This pays</TableHead>
                        <TableHead className="text-right">Left owing</TableHead>
                        <TableHead>Becomes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {proposal.proposal.allocations.map((allocation) => (
                        <TableRow key={allocation.invoiceId}>
                          <TableCell>
                            <Link
                              href={`/invoices/${allocation.invoiceId}`}
                              className="font-medium hover:underline"
                            >
                              {allocation.number}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatGBP(allocation.outstandingBeforePence)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatGBP(allocation.amountPence)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatGBP(allocation.outstandingAfterPence)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                allocation.becomes === 'PAID' ? 'success' : 'warning'
                              }
                            >
                              {allocation.becomes === 'PAID' ? 'Paid' : 'Part paid'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {proposal.proposal.unallocatedPence > 0 ? (
                  <Alert>
                    <AlertDescription>
                      {formatGBP(proposal.proposal.unallocatedPence)} more than is
                      outstanding. It will be held as a credit against{' '}
                      {proposal.payerName} rather than forced onto an invoice.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {proposal.proposal.skipped.length > 0 ? (
                  <div className="text-sm text-muted-foreground">
                    <p className="font-medium">Left alone:</p>
                    <ul className="list-inside list-disc">
                      {proposal.proposal.skipped.map((skip) => (
                        <li key={skip.number}>
                          {skip.number} — {skip.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {editable ? (
                  <form method="post" action={action}>
                    <input type="hidden" name="intent" value="allocate" />
                    <Button
                      type="submit"
                      disabled={
                        proposal.proposal.allocations.length === 0 &&
                        proposal.proposal.unallocatedPence === 0
                      }
                    >
                      Confirm
                    </Button>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {proposal.kind === 'payout' ? (
            <Card>
              <CardHeader>
                <CardTitle>Which payout this paid</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {proposal.match.kind === 'none' ? (
                  <p className="text-sm text-muted-foreground">{proposal.match.reason}</p>
                ) : (
                  <>
                    {proposal.match.kind === 'several' ? (
                      <Alert>
                        <AlertDescription>
                          {proposal.match.candidates.length} approved payouts are for this
                          exact amount. Picking one at random would mark the wrong driver
                          paid, so choose.
                        </AlertDescription>
                      </Alert>
                    ) : null}

                    {editable ? (
                      <form method="post" action={action} className="flex flex-wrap items-end gap-3">
                        <input type="hidden" name="intent" value="payout" />
                        <div>
                          <label htmlFor="payoutId" className="mb-1 block text-sm font-medium">
                            Payout
                          </label>
                          <Select id="payoutId" name="payoutId" className="w-80">
                            {(proposal.match.kind === 'one'
                              ? [proposal.match.payout]
                              : proposal.match.candidates
                            ).map((payout) => (
                              <option key={payout.id} value={payout.id}>
                                {payout.driverName} · {formatDate(payout.periodStart)} to{' '}
                                {formatDate(payout.periodEnd)} ·{' '}
                                {formatGBP(payout.totalPence)}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Button type="submit">Mark paid</Button>
                      </form>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}

          {proposal.kind === 'cost' ? (
            <Card>
              <CardHeader>
                <CardTitle>Record against a vehicle</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-muted-foreground">
                  Writes the same cost the fleet screens write, so a fuel bill that
                  arrived through the bank and one typed in by hand land in the same
                  place.
                </p>
                {editable ? (
                  <form method="post" action={action} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="intent" value="cost" />
                    <div>
                      <label htmlFor="vehicleId" className="mb-1 block text-sm font-medium">
                        Vehicle
                      </label>
                      <Select
                        id="vehicleId"
                        name="vehicleId"
                        defaultValue={proposal.vehicleId ?? ''}
                        className="w-56"
                      >
                        <option value="">Choose one</option>
                        {vehicles.map((vehicle) => (
                          <option key={vehicle.id} value={vehicle.id}>
                            {vehicle.registration}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <label htmlFor="costKind" className="mb-1 block text-sm font-medium">
                        Kind
                      </label>
                      <Select
                        id="costKind"
                        name="costKind"
                        defaultValue={proposal.suggestedKind}
                        className="w-48"
                      >
                        {COST_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind.replace(/_/g, ' ').toLowerCase()}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <label htmlFor="note" className="mb-1 block text-sm font-medium">
                        Note
                      </label>
                      <Input id="note" name="note" className="w-56" />
                    </div>
                    <Button type="submit">Record {formatGBP(Math.abs(txn.amountPence))}</Button>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {proposal.kind === 'ignore' ? (
            <Card>
              <CardHeader>
                <CardTitle>Nothing to do</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{proposal.reason}</p>
                {editable ? (
                  <form method="post" action={action}>
                    <input type="hidden" name="intent" value="ignore" />
                    <Button type="submit" variant="outline">
                      Mark as dealt with
                    </Button>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {proposal.kind === 'none' && !txn.allocatedAt ? (
            <Alert>
              <AlertDescription>{proposal.reason}</AlertDescription>
            </Alert>
          ) : null}

          {txn.allocations.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>What was created from it</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Landed on</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {txn.allocations.map((allocation) => (
                      <TableRow key={allocation.id}>
                        <TableCell>
                          {allocation.invoice ? (
                            <Link
                              href={`/invoices/${allocation.invoice.id}`}
                              className="hover:underline"
                            >
                              {allocation.invoice.number}
                            </Link>
                          ) : allocation.payout ? (
                            <Link
                              href={`/payouts/${allocation.payout.id}`}
                              className="hover:underline"
                            >
                              Payout to {allocation.payout.driver.name}
                            </Link>
                          ) : allocation.costId ? (
                            'Vehicle cost'
                          ) : (
                            'Marked as dealt with'
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatGBP(allocation.amountPence)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>From the statement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Date" value={formatDate(txn.occurredOn)} />
            <Row label="Amount" value={formatGBP(txn.amountPence)} />
            <Row label="Reference" value={txn.bankRef ?? '—'} />
            <Row label="File" value={txn.statement.filename} />
            <Row label="Layout" value={txn.statement.layout} />
            {txn.allocatedAt ? (
              <Row label="Allocated" value={formatGBP(txn.allocatedPence)} />
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
