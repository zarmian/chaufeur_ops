import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { can } from '@/lib/authz';
import { formatDateTime } from '@/lib/dates';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { getShiftWithTotals } from '@/lib/shift-store';
import { formatShiftLength } from '@/lib/shifts';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { CloseShiftForm } from '../shift-form';

export const metadata = { title: 'Shift' };

export default async function ShiftDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const shiftError = filterValue(query, 'shiftError');

  const shift = await getShiftWithTotals(id);
  if (!shift) notFound();

  const mayEdit = can(user, 'editDrivers');
  const { profit } = shift;

  return (
    <>
      <PageHeader
        title={shift.reference}
        description={`${shift.driver.name}${shift.vehicle ? ` · ${shift.vehicle.registration}` : ''}`}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                The shift
                {shift.endedAt ? (
                  shift.approvedAt ? (
                    <Badge variant="success">Approved</Badge>
                  ) : (
                    <Badge variant="secondary">Ended</Badge>
                  )
                ) : (
                  <Badge variant="warning" data-testid="shift-open">
                    Open
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Field label="Clocked on">{formatDateTime(shift.startedAt)}</Field>
                <Field label="Clocked off">
                  {shift.endedAt ? formatDateTime(shift.endedAt) : 'Still working'}
                </Field>
                <Field label="Unpaid break">{shift.breakMinutes} minutes</Field>
                <Field label="Paid time">{formatShiftLength(shift.minutes)}</Field>
                <Field label="Rate">{formatGBP(shift.hourlyRatePence)} per hour</Field>
                <Field label="Pay">
                  {shift.payPence === null ? '—' : formatGBP(shift.payPence)}
                </Field>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Jobs on this shift</CardTitle>
              <CardDescription>
                These carry no per-job driver cost — the driver was paid for the
                time, not the journey.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {shift.jobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No jobs attributed yet. A shift with no work is still owed for
                  the hours.
                </p>
              ) : (
                <ul className="divide-y">
                  {shift.jobs.map((job) => (
                    <li
                      key={job.id}
                      className="flex items-center justify-between gap-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="tabular text-sm font-medium hover:underline"
                        >
                          {job.reference}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatDateTime(job.scheduledAt)} · {job.pickupText} →{' '}
                          {job.dropoffText}
                        </p>
                      </div>
                      <span className="tabular whitespace-nowrap text-sm">
                        {formatGBP(job.economics.totalClientPence)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {mayEdit && !shift.endedAt ? (
            <Card>
              <CardHeader>
                <CardTitle>End the shift</CardTitle>
              </CardHeader>
              <CardContent>
                <CloseShiftForm
                  shiftId={shift.id}
                  defaultBreakMinutes={shift.breakMinutes}
                  error={shiftError}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Profitability</CardTitle>
              <CardDescription>
                Revenue of the jobs worked, less the pay and what the company
                spent running the car.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Revenue">{formatGBP(profit.revenuePence)}</Row>
              <Row label="Driver pay">{formatGBP(profit.payPence)}</Row>
              <Row label="Company expenses">{formatGBP(profit.expensePence)}</Row>
              <div className="border-t pt-3" />
              <Row label="Gross profit">
                <span
                  className={
                    profit.grossProfitPence < 0
                      ? 'font-medium text-destructive'
                      : 'font-medium'
                  }
                >
                  {formatGBP(profit.grossProfitPence)}
                  {profit.marginPct !== null ? ` · ${profit.marginPct.toFixed(1)}%` : ''}
                </span>
              </Row>
            </CardContent>
          </Card>
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
