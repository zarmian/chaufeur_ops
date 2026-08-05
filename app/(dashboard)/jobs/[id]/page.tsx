import { Copy, Pencil, Repeat } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ComplianceBadge } from '@/components/compliance-badge';
import { JobStatusBadge } from '@/components/job-status-badge';
import { PageHeader } from '@/components/page-header';
import { UnpricedBadge } from '@/components/unpriced-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { can } from '@/lib/authz';
import { checkAssignmentCompliance, getJob } from '@/lib/jobs';
import { formatDate, formatDateTime } from '@/lib/dates';
import { buildTimeline, ACTOR_LABELS } from '@/lib/job-events';
import { allowedTransitions, hasPriceOrReason } from '@/lib/job-status';
import { JOB_TYPES } from '@/lib/enum-options';
import { formatGBP, marginPct } from '@/lib/money';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { StatusControl } from './status-control';

export const metadata = { title: 'Job' };

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const [{ id }, query] = await Promise.all([params, searchParams]);

  // A refused transition comes back on the URL, so the message survives the
  // navigation and can be linked to.
  const statusError = filterValue(query, 'statusError');

  const job = await getJob(id);
  if (!job) notFound();

  const priced = hasPriceOrReason(job);
  const mayEdit = can(user, 'editJobs');
  const maySeeFinance = can(user, 'viewReports') || can(user, 'editJobFinances');
  const timeline = buildTimeline(job.events);

  // Only worth the queries while the job could still be assigned.
  const compliance =
    mayEdit && !['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(job.status)
      ? await checkAssignmentCompliance(job.driverId, job.vehicleId, job.scheduledAt)
      : null;

  const invoice = job.invoiceLines[0]?.invoice ?? null;
  const revenue = job.finance?.totalClientPence ?? job.clientPricePence ?? 0;
  const profit = job.finance?.grossProfitPence ?? null;
  const margin = profit === null ? null : marginPct(revenue, profit);

  return (
    <>
      <PageHeader
        title={job.reference}
        description={`${job.pickupText} → ${job.dropoffText}`}
        actions={
          mayEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href={`/jobs/new?from=${job.id}`}>
                  <Copy aria-hidden />
                  Duplicate
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/jobs/new?from=${job.id}&return=true`}>
                  <Repeat aria-hidden />
                  Return journey
                </Link>
              </Button>
              <Button asChild>
                <Link href={`/jobs/${job.id}/edit`}>
                  <Pencil aria-hidden />
                  Edit
                </Link>
              </Button>
            </div>
          ) : null
        }
      />

      {!priced ? (
        <Alert variant="destructive" className="mb-6" data-testid="unpriced-alert">
          <AlertTitle>This job has no price</AlertTitle>
          <AlertDescription>
            It will not appear in any revenue report, and it cannot be
            completed until a price or a zero-value reason is recorded.
          </AlertDescription>
        </Alert>
      ) : null}

      {compliance && !compliance.compliant ? (
        <Alert variant="destructive" className="mb-6" data-testid="compliance-alert">
          <AlertTitle>
            This driver or vehicle cannot be assigned to a job
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {compliance.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Booking</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Field label="Pickup time">
                  <span className="tabular">{formatDateTime(job.scheduledAt)}</span>
                </Field>
                <Field label="Type">{jobTypeLabel(job.jobType)}</Field>
                <Field label="Pickup">{job.pickupText}</Field>
                <Field label="Destination">{job.dropoffText}</Field>
                {job.viaText ? <Field label="Via">{job.viaText}</Field> : null}
                {job.flightNumber ? (
                  <Field label="Flight">{job.flightNumber}</Field>
                ) : null}
                <Field label="Client">
                  {job.client ? (
                    <Link href={`/clients/${job.client.id}`} className="hover:underline">
                      {job.client.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Field>
                <Field label="Account">
                  {job.account ? (
                    <Link
                      href={`/accounts/${job.account.id}`}
                      className="hover:underline"
                    >
                      {job.account.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Field>
                <Field label="Driver">
                  {job.driver ? (
                    <Link href={`/drivers/${job.driver.id}`} className="hover:underline">
                      {job.driver.name}
                    </Link>
                  ) : (
                    <span className="italic text-muted-foreground">Unassigned</span>
                  )}
                </Field>
                <Field label="Vehicle">
                  {job.vehicle ? (
                    <Link
                      href={`/vehicles/${job.vehicle.id}`}
                      className="tabular hover:underline"
                    >
                      {job.vehicle.registration}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Field>
                {job.passengerName ? (
                  <Field label="Passenger">{job.passengerName}</Field>
                ) : null}
                {job.passengerPhone ? (
                  <Field label="Passenger phone">{job.passengerPhone}</Field>
                ) : null}
              </dl>

              {job.notes ? (
                <div className="mt-6 border-t pt-4">
                  <p className="text-sm font-medium">Notes</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {job.notes}
                  </p>
                </div>
              ) : null}

              {job.internalNotes && mayEdit ? (
                <div className="mt-4 border-t pt-4">
                  <p className="text-sm font-medium">
                    Internal notes
                    <span className="ml-2 font-normal text-xs text-muted-foreground">
                      Never shown to the driver
                    </span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {job.internalNotes}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
              <CardDescription>
                Every status change, with the gap between each. Waiting time is
                billable above the free allowance.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No events recorded yet.
                </p>
              ) : (
                <ol className="divide-y">
                  {timeline.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-baseline justify-between gap-4 py-2.5"
                    >
                      <div>
                        <p className="text-sm font-medium">{entry.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {ACTOR_LABELS[entry.actorType]}
                          {entry.sincePrevious
                            ? ` · ${entry.sincePrevious} after the previous step`
                            : ''}
                        </p>
                      </div>
                      <span className="tabular whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(entry.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                Status
                <JobStatusBadge status={job.status} data-testid="job-status" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {mayEdit ? (
                <StatusControl
                  jobId={job.id}
                  allowed={[...allowedTransitions(job.status)]}
                  needsZeroValueReason={!priced}
                  error={statusError}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Your role cannot change a job&apos;s status.
                </p>
              )}
            </CardContent>
          </Card>

          {maySeeFinance ? (
            <Card>
              <CardHeader>
                <CardTitle>Finance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Row label="Client price">
                  {priced ? formatGBP(job.clientPricePence ?? 0) : <UnpricedBadge />}
                </Row>
                <Row label="Driver price">
                  {job.driverPricePence === null
                    ? '—'
                    : formatGBP(job.driverPricePence)}
                </Row>
                {job.zeroValueReason ? (
                  <Row label="Zero-value reason">{job.zeroValueReason}</Row>
                ) : null}

                {job.finance ? (
                  <>
                    <div className="border-t pt-3" />
                    <Row label="Revenue">
                      {formatGBP(job.finance.totalClientPence)}
                    </Row>
                    <Row label="Costs">{formatGBP(job.finance.totalCostsPence)}</Row>
                    <Row label="Gross profit">
                      <span
                        className={
                          job.finance.grossProfitPence < 0
                            ? 'font-medium text-destructive'
                            : 'font-medium'
                        }
                      >
                        {formatGBP(job.finance.grossProfitPence)}
                        {margin !== null ? ` · ${margin.toFixed(1)}%` : ''}
                      </span>
                    </Row>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No finance record yet. Opening the panel pre-fills it from
                    the booking prices.
                  </p>
                )}

                {can(user, 'editJobFinances') ? (
                  <Button asChild variant="outline" className="w-full">
                    <Link href={`/jobs/${job.id}/finance`}>Open finance panel</Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {invoice ? (
            <Card>
              <CardHeader>
                <CardTitle>Invoice</CardTitle>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/invoices/${invoice.id}`}
                  className="tabular font-medium hover:underline"
                >
                  {invoice.number}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {invoice.status}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {job.driver && compliance ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  Compliance
                  <ComplianceBadge level={compliance.level} />
                </CardTitle>
                <CardDescription>
                  Checked against the pickup time, {formatDate(job.scheduledAt)}.
                </CardDescription>
              </CardHeader>
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
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
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

function jobTypeLabel(value: string): string {
  return JOB_TYPES.find((type) => type.value === value)?.label ?? value;
}
