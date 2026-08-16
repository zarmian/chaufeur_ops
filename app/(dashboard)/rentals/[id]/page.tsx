import Link from 'next/link';
import { notFound } from 'next/navigation';
import { renterName } from '@/lib/rentals';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { can } from '@/lib/authz';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { getRental } from '@/lib/rental-store';
import {
  fuelDifferencePct,
  mileageDriven,
  RATE_TYPE_UNIT,
  RENTAL_STATUS_LABELS,
} from '@/lib/rentals';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { PaymentForm, ReturnForm } from './forms';

export const metadata = { title: 'Rental' };

export default async function RentalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const rentalError = filterValue(query, 'rentalError');

  const rental = await getRental(id);
  if (!rental) notFound();

  const mayEdit = can(user, 'editVehicles');
  const mayTakeMoney = can(user, 'editJobFinances');
  const { balance } = rental;
  const miles = mileageDriven(rental.mileageOut, rental.mileageIn);
  const fuel = fuelDifferencePct(rental.fuelOutPct, rental.fuelInPct);

  return (
    <>
      <PageHeader
        title={rental.reference}
        description={`${rental.vehicle.registration} · ${renterName(rental)}`}
      />

      {balance.inArrears ? (
        <Alert variant="destructive" className="mb-6" data-testid="arrears-alert">
          <AlertTitle>{formatGBP(balance.balancePence)} still owed</AlertTitle>
          <AlertDescription>
            {formatGBP(balance.totalPence)} charged, {formatGBP(balance.paidPence)}{' '}
            received.
            {balance.depositHeldPence > 0
              ? ` A deposit of ${formatGBP(balance.depositHeldPence)} is held separately and is not part of this.`
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                The hire
                <Badge
                  variant={rental.status === 'ACTIVE' ? 'warning' : 'secondary'}
                  data-testid="rental-status"
                >
                  {RENTAL_STATUS_LABELS[rental.status]}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Field label="Vehicle">
                  <Link
                    href={`/vehicles/${rental.vehicle.id}`}
                    className="tabular hover:underline"
                  >
                    {rental.vehicle.registration}
                  </Link>
                </Field>
                <Field label="Renting to">
                  {/* Only a driver has a page to link to; a company or a
                      one-off hirer is named and nothing more. */}
                  {rental.driver ? (
                    <Link href={`/drivers/${rental.driver.id}`} className="hover:underline">
                      {rental.driver.name}
                    </Link>
                  ) : rental.account ? (
                    <Link href={`/accounts/${rental.account.id}`} className="hover:underline">
                      {rental.account.name}
                    </Link>
                  ) : (
                    renterName(rental)
                  )}
                </Field>
                <Field label="Went out">{formatDateTime(rental.startAt)}</Field>
                <Field label="Due back">{formatDateTime(rental.endAt)}</Field>
                {rental.returnedAt ? (
                  <Field label="Came back">{formatDateTime(rental.returnedAt)}</Field>
                ) : null}
                <Field label="Rate">
                  {formatGBP(rental.ratePence)} per {RATE_TYPE_UNIT[rental.rateType]}
                </Field>
                <Field label="Mileage">
                  {rental.mileageOut ?? '—'}
                  {rental.mileageIn !== null ? ` → ${rental.mileageIn}` : ''}
                  {miles !== null ? ` (${miles} miles)` : ''}
                </Field>
                <Field label="Fuel or charge">
                  {rental.fuelOutPct !== null ? `${rental.fuelOutPct}%` : '—'}
                  {rental.fuelInPct !== null ? ` → ${rental.fuelInPct}%` : ''}
                  {fuel !== null && fuel < 0 ? (
                    <span className="ml-1 text-destructive">({fuel} pts)</span>
                  ) : null}
                </Field>
              </dl>

              {rental.damageNotes ? (
                <div className="mt-6 border-t pt-4">
                  <p className="text-sm font-medium text-destructive">Damage</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {rental.damageNotes}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Handover checklist</CardTitle>
              <CardDescription>
                Recorded at collection and again at return, so the two can be
                compared line by line.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rental.checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
              ) : (
                <div className="grid gap-6 sm:grid-cols-2">
                  {(['OUT', 'IN'] as const).map((phase) => {
                    const items = rental.checks.filter((check) => check.phase === phase);
                    if (items.length === 0) return null;
                    return (
                      <div key={phase}>
                        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                          {phase === 'OUT' ? 'At collection' : 'At return'}
                        </p>
                        <ul className="space-y-1.5">
                          {items.map((item) => (
                            <li key={item.id} className="flex items-start gap-2 text-sm">
                              <span
                                className={
                                  item.ok ? 'text-success' : 'text-destructive'
                                }
                                aria-hidden
                              >
                                {item.ok ? '✓' : '✗'}
                              </span>
                              <span className={item.ok ? '' : 'text-destructive'}>
                                {item.label}
                                {item.note ? ` — ${item.note}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {mayEdit && rental.status !== 'RETURNED' && rental.status !== 'CANCELLED' ? (
            <Card>
              <CardHeader>
                <CardTitle>Book the car back in</CardTitle>
                <CardDescription>
                  A late return is charged to the actual date. An early one is
                  credited.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ReturnForm rentalId={rental.id} error={rentalError} />
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Money</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label={`${balance.periods} × rate`}>
                {formatGBP(balance.rentalPence)}
              </Row>
              {balance.damageChargePence > 0 ? (
                <Row label="Damage">{formatGBP(balance.damageChargePence)}</Row>
              ) : null}
              <div className="border-t pt-3" />
              <Row label="Charged">
                <span className="font-medium">{formatGBP(balance.totalPence)}</span>
              </Row>
              <Row label="Received">{formatGBP(balance.paidPence)}</Row>
              <Row label="Owing">
                <span
                  className={
                    balance.inArrears ? 'font-medium text-destructive' : 'font-medium'
                  }
                >
                  {formatGBP(balance.balancePence)}
                </span>
              </Row>
              {balance.depositHeldPence > 0 ? (
                <>
                  <div className="border-t pt-3" />
                  <Row label="Deposit held">
                    {formatGBP(balance.depositHeldPence)}
                  </Row>
                  <p className="text-xs text-muted-foreground">
                    Held against damage. Not a payment toward the hire.
                  </p>
                </>
              ) : null}
            </CardContent>
          </Card>

          {mayTakeMoney ? (
            <Card>
              <CardHeader>
                <CardTitle>Record a payment</CardTitle>
              </CardHeader>
              <CardContent>
                <PaymentForm rentalId={rental.id} />
              </CardContent>
            </Card>
          ) : null}

          {rental.payments.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Payments</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {rental.payments.map((payment) => (
                    <li
                      key={payment.id}
                      className="flex items-center justify-between gap-4 py-2 text-sm"
                    >
                      <span className="text-muted-foreground">
                        {formatDate(payment.paidAt)}
                        {payment.method ? ` · ${payment.method}` : ''}
                      </span>
                      <span className="tabular">{formatGBP(payment.amountPence)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm tabular">{children}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular text-right">{children}</span>
    </div>
  );
}
