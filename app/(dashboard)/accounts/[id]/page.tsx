import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAccount } from '@/lib/accounts';
import { can } from '@/lib/authz';
import { formatDate } from '@/lib/dates';
import { formatGBP, marginPct } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';

export const metadata = { title: 'Account' };

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const { id } = await params;

  const account = await getAccount(id);
  if (!account) notFound();

  const [clients, jobs, finance, invoices] = await Promise.all([
    prisma.client.findMany({
      where: { defaultAccountId: id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 20,
    }),
    prisma.job.findMany({
      where: { accountId: id },
      orderBy: { scheduledAt: 'desc' },
      take: 10,
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        pickupText: true,
        dropoffText: true,
        clientPricePence: true,
      },
    }),
    prisma.jobFinance.aggregate({
      where: { job: { accountId: id, status: 'COMPLETED' } },
      _sum: { totalClientPence: true, grossProfitPence: true },
    }),
    prisma.invoice.aggregate({
      where: { accountId: id, status: { in: ['SENT', 'PART_PAID', 'OVERDUE'] } },
      _sum: { grossPence: true, paidPence: true },
    }),
  ]);

  const maySeeMoney = can(user, 'viewRevenue');
  const revenue = finance._sum.totalClientPence ?? 0;
  const profit = finance._sum.grossProfitPence ?? 0;
  const margin = marginPct(revenue, profit);
  const outstanding =
    (invoices._sum.grossPence ?? 0) - (invoices._sum.paidPence ?? 0);

  return (
    <>
      <PageHeader
        title={account.name}
        description={`${account.kind.toLowerCase()} account · ${account.paymentTermsDays} day terms`}
        actions={
          <div className="flex items-center gap-2">
            {!account.active ? <Badge variant="secondary">Inactive</Badge> : null}
            {can(user, 'editClients') ? (
              <Button asChild variant="outline">
                <Link href={`/accounts/${account.id}/edit`}>
                  <Pencil aria-hidden />
                  Edit
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Contact" value={account.contactName} />
            <Row label="Phone" value={account.contactPhone} />
            <Row label="Email" value={account.contactEmail} />
            <Row label="Billing email" value={account.billingEmail} />
            <Row label="Billing address" value={account.billingAddress} />
            <Row label="VAT number" value={account.vatNumber} />
            <Row
              label="Commission"
              value={
                account.commissionPct ? `${account.commissionPct.toString()}%` : null
              }
            />
          </CardContent>
        </Card>

        {maySeeMoney ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Margin</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-muted-foreground">Revenue</p>
                <p className="text-2xl font-semibold tabular">{formatGBP(revenue)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Gross profit</p>
                <p className="text-lg font-semibold tabular">{formatGBP(profit)}</p>
                <p className="text-xs text-muted-foreground">
                  {margin === null
                    ? 'No priced jobs yet — margin is undefined, not zero'
                    : `${margin}% margin`}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Outstanding</p>
                <p className="text-lg font-semibold tabular">
                  {formatGBP(outstanding)}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card className={maySeeMoney ? '' : 'lg:col-span-2'}>
          <CardHeader>
            <CardTitle className="text-base">Clients defaulting here</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {clients.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <ul className="space-y-1">
                {clients.map((client) => (
                  <li key={client.id}>
                    <Link href={`/clients/${client.id}`} className="hover:underline">
                      {client.name}
                    </Link>
                  </li>
                ))}
              </ul>
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
                <li key={job.id} className="flex items-center justify-between gap-4 py-2">
                  <div>
                    <Link
                      href={`/jobs/${job.id}`}
                      className="font-medium tabular hover:underline"
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
                        <span className="font-medium text-destructive">No price</span>
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
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={value ? 'whitespace-pre-wrap' : 'text-muted-foreground'}>
        {value ?? '—'}
      </p>
    </div>
  );
}
