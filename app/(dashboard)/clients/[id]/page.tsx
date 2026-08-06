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

  // Spec 6.4.6. Loaded separately from the block above so the favourites card
  // can be added without disturbing the aggregates it sits beside.
  const [favourites, savedLocations] = await Promise.all([
    prisma.clientFavouriteLocation.findMany({
      where: { clientId: id },
      include: { location: { select: { id: true, label: true, address: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.location.findMany({
      select: { id: true, label: true, address: true },
      orderBy: [{ useCount: 'desc' }, { label: 'asc' }],
      take: 200,
    }),
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

      {/* Spec 6.4.6 — offered ahead of everything else on this client's
          bookings. A corporate account whose people always go to the same
          office should not scroll past Heathrow to find it. */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Favourite locations</CardTitle>
        </CardHeader>
        <CardContent>
          {favourites.length === 0 ? (
            <p className="mb-4 text-sm text-muted-foreground">
              None yet. Anything added here is offered first when this client is
              on the booking.
            </p>
          ) : (
            <ul className="mb-4 space-y-2 text-sm" data-testid="client-favourites">
              {favourites.map((favourite) => (
                <li
                  key={favourite.locationId}
                  className="flex items-baseline justify-between gap-3"
                  data-location-id={favourite.locationId}
                >
                  <span className="min-w-0">
                    <span className="font-medium">{favourite.location.label}</span>
                    <span className="ml-2 text-muted-foreground">
                      {favourite.location.address}
                    </span>
                  </span>
                  {mayEdit ? (
                    <form method="post" action={`/api/clients/${client.id}/favourites`}>
                      <input type="hidden" name="intent" value="remove" />
                      <input
                        type="hidden"
                        name="locationId"
                        value={favourite.locationId}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        Remove
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {mayEdit && savedLocations.length > 0 ? (
            <form
              method="post"
              action={`/api/clients/${client.id}/favourites`}
              className="flex flex-wrap items-end gap-3"
              data-testid="client-favourite-form"
            >
              <input type="hidden" name="intent" value="add" />
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Add a saved location</span>
                <select
                  name="locationId"
                  defaultValue=""
                  className="flex h-9 w-72 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  <option value="">Choose a location</option>
                  {savedLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="outline">
                Add
              </Button>
            </form>
          ) : null}
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
