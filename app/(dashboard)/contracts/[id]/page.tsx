import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { JobStatusBadge } from '@/components/job-status-badge';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/authz';
import { describeWeekdays, getContract } from '@/lib/contracts';
import { formatDate, formatDateTime } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { ContractControls } from './controls';

export const metadata = { title: 'Contract' };

export default async function ContractDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const notice = filterValue(query, 'contractNotice');

  const contract = await getContract(id);
  if (!contract) notFound();

  // The days it has produced. Recent first, because "is next week booked" is
  // the question, and a contract running for a year has hundreds behind it.
  const [days, total] = await Promise.all([
    prisma.job.findMany({
      where: { contractId: contract.id },
      orderBy: { scheduledAt: 'desc' },
      take: 30,
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        status: true,
        driver: { select: { name: true } },
        finance: { select: { totalClientPence: true } },
      },
    }),
    prisma.job.count({ where: { contractId: contract.id } }),
  ]);

  const mayEdit = can(user, 'editJobs');

  return (
    <>
      <PageHeader
        title={contract.label}
        description={`${contract.reference} · ${contract.pickupText} → ${contract.dropoffText}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={contract.active ? 'success' : 'secondary'}>
              {contract.active ? 'Running' : 'Stopped'}
            </Badge>
            {mayEdit ? (
              <Button asChild variant="outline">
                <Link href={`/contracts/${contract.id}/edit`}>
                  <Pencil className="mr-1 size-4" aria-hidden />
                  Edit
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {/* What a repricing actually did, including the days it could not
          touch. An operator who assumed everything moved would bill the
          difference and wonder why it did not reconcile. */}
      {notice ? (
        <Alert className="mb-6" data-testid="contract-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!contract.active ? (
        <Alert className="mb-6">
          <AlertDescription>
            This contract is stopped, so no more days will be created. The days
            it already made are still bookings — cancel any that are not going
            to happen.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>The arrangement</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Field label="Runs">
                  {describeWeekdays(contract.weekdays)} at {contract.startTime}
                </Field>
                <Field label="From">
                  {formatDate(contract.startsOn)}
                  {contract.endsOn
                    ? ` to ${formatDate(contract.endsOn)}`
                    : ' — open-ended'}
                </Field>
                <Field label="Billed to">
                  {contract.account?.name ?? contract.client?.name ?? '—'}
                </Field>
                <Field label="Usual driver">
                  {contract.driver?.name ?? 'Unassigned'}
                </Field>
                <Field label="Usual vehicle">
                  {contract.vehicle?.registration ?? 'Unassigned'}
                </Field>
                <Field label="Booked through">
                  {contract.generatedThroughOn
                    ? formatDate(contract.generatedThroughOn)
                    : 'Not yet'}
                </Field>
              </dl>

              {contract.notes ? (
                <p className="mt-6 whitespace-pre-wrap border-t pt-4 text-sm text-muted-foreground">
                  {contract.notes}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Days</CardTitle>
              <CardDescription>
                Ordinary jobs. Reassign, reprice or cancel any of them without
                touching the contract — {total} created so far.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {days.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet. They are created overnight, or immediately with
                  &ldquo;Book the next days&rdquo;.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {days.map((day) => (
                      <TableRow key={day.id}>
                        <TableCell>
                          <Link
                            href={`/jobs/${day.id}`}
                            className="font-medium tabular hover:underline"
                          >
                            {day.reference}
                          </Link>
                        </TableCell>
                        <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                          {formatDateTime(day.scheduledAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {day.driver?.name ?? (
                            <span className="italic">Unassigned</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <JobStatusBadge status={day.status} />
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {formatGBP(day.finance?.totalClientPence ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>A day</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Charged">{formatGBP(contract.dayRatePence)}</Row>
              <Row label="Driver paid">
                {formatGBP(contract.driverDayRatePence)}
              </Row>
              <div className="border-t pt-3" />
              <Row label="Gross profit">
                <span
                  className={
                    contract.dayRatePence - contract.driverDayRatePence < 0
                      ? 'font-medium text-destructive'
                      : 'font-medium'
                  }
                >
                  {formatGBP(contract.dayRatePence - contract.driverDayRatePence)}
                </span>
              </Row>
            </CardContent>
          </Card>

          {mayEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Actions</CardTitle>
                <CardDescription>
                  Days are booked {contract.generateAheadDays} days ahead,
                  overnight.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ContractControls
                  contractId={contract.id}
                  active={contract.active}
                />
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
