import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { can } from '@/lib/authz';
import { findPossibleDuplicates } from '@/lib/clients';
import { formatDate } from '@/lib/dates';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { includeDeleted, prisma } from '@/lib/prisma';
import { ArchiveControls } from './archive-controls';

export const metadata = { title: 'Client' };

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const { id } = await params;

  // Archived clients stay viewable — the record is why an old invoice exists.
  const client = await prisma.client.findFirst(
    includeDeleted({
      where: { id },
      include: { defaultAccount: { select: { id: true, name: true } } },
    }),
  );
  if (!client) notFound();

  const [jobs, finance, outstanding, duplicates] = await Promise.all([
    prisma.job.findMany({
      where: { clientId: id },
      orderBy: { scheduledAt: 'desc' },
      take: 10,
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        status: true,
        pickupText: true,
        dropoffText: true,
        clientPricePence: true,
      },
    }),
    // Lifetime revenue comes from the reconciled finance record, not the
    // booking price, so extras and wait time are included.
    prisma.jobFinance.aggregate({
      where: { job: { clientId: id, status: 'COMPLETED' } },
      _sum: { totalClientPence: true },
    }),
    prisma.invoice.aggregate({
      where: {
        clientId: id,
        status: { in: ['SENT', 'PART_PAID', 'OVERDUE'] },
      },
      _sum: { grossPence: true, paidPence: true },
    }),
    findPossibleDuplicates(client.name, client.id),
  ]);

  const lifetimeRevenue = finance._sum.totalClientPence ?? 0;
  const outstandingBalance =
    (outstanding._sum.grossPence ?? 0) - (outstanding._sum.paidPence ?? 0);

  const mayEdit = can(user, 'editClients') && client.deletedAt === null;
  const maySeeMoney = can(user, 'viewRevenue');

  return (
    <>
      <PageHeader
        title={client.name}
        description={
          client.deletedAt
            ? `Archived ${formatDate(client.deletedAt)}`
            : client.defaultAccount
              ? `Usually invoiced to ${client.defaultAccount.name}`
              : 'No default account — invoices go to the client directly'
        }
        actions={
          <div className="flex items-center gap-2">
            {client.deletedAt ? (
              <Badge variant="secondary">Archived</Badge>
            ) : null}
            {mayEdit ? (
              <Button asChild variant="outline">
                <Link href={`/clients/${client.id}/edit`}>
                  <Pencil aria-hidden />
                  Edit
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {duplicates.length > 0 ? (
        <Card className="mb-6 border-warning/50 bg-warning/10">
          <CardContent className="p-4 text-sm">
            <p className="font-medium">
              {duplicates.length} other record
              {duplicates.length === 1 ? '' : 's'} with a matching name
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {duplicates.map((duplicate) => (
                <li key={duplicate.id}>
                  <Link
                    href={`/clients/${duplicate.id}`}
                    className="underline"
                  >
                    {duplicate.name}
                  </Link>
                  {duplicate.contactPhone ? ` · ${duplicate.contactPhone}` : ''}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Detail label="Phone" value={client.contactPhone} />
            <Detail label="Email" value={client.contactEmail} />
            <Detail label="Billing email" value={client.billingEmail} />
            <Detail label="Billing address" value={client.billingAddress} />
            <Detail label="VAT number" value={client.vatNumber} />
            <Detail
              label="Payment terms"
              value={`${client.paymentTermsDays} days`}
            />
          </CardContent>
        </Card>

        {maySeeMoney ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Money</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-muted-foreground">Lifetime revenue</p>
                <p className="text-2xl font-semibold tabular">
                  {formatGBP(lifetimeRevenue)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Completed jobs, from reconciled finance records
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Outstanding</p>
                <p className="text-lg font-semibold tabular">
                  {formatGBP(outstandingBalance)}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card className={maySeeMoney ? '' : 'lg:col-span-2'}>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {client.notes ? (
              <p className="whitespace-pre-wrap">{client.notes}</p>
            ) : (
              <p className="text-muted-foreground">None.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Recent jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No jobs yet. Job records arrive in Phase 2.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <div>
                    <Link
                      href={`/jobs/${job.id}`}
                      className="font-medium hover:underline tabular"
                    >
                      {job.reference}
                    </Link>
                    <p className="text-muted-foreground">
                      {job.pickupText} → {job.dropoffText}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular">{formatDate(job.scheduledAt)}</p>
                    <p className="text-muted-foreground">
                      {job.clientPricePence === null ? (
                        <span className="font-medium text-destructive">
                          No price
                        </span>
                      ) : (
                        formatGBP(job.clientPricePence)
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {can(user, 'deleteRecords') ? (
        <ArchiveControls
          clientId={client.id}
          isArchived={client.deletedAt !== null}
        />
      ) : null}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={value ? 'whitespace-pre-wrap' : 'text-muted-foreground'}>
        {value ?? '—'}
      </p>
    </div>
  );
}
