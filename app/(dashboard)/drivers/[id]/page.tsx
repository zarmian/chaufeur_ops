import { AlertTriangle, Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ComplianceBadge, ComplianceItems } from '@/components/compliance-badge';
import { DocumentPanel } from '@/components/documents/document-panel';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { can } from '@/lib/authz';
import { combinedComplianceAt } from '@/lib/compliance';
import { formatDate, formatDateTime, toDateOnlyString } from '@/lib/dates';
import { DOCUMENT_TYPES, documentLabel, requiresExpiry } from '@/lib/documents';
import { findFutureJobs, findVehicleSharers, getDriver } from '@/lib/drivers';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { getComplianceThresholds } from '@/lib/settings';
import { isStorageConfigured } from '@/lib/storage';

export const metadata = { title: 'Driver' };

export default async function DriverDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const { id } = await params;

  const driver = await getDriver(id);
  if (!driver) notFound();

  const thresholds = await getComplianceThresholds();
  const compliance = combinedComplianceAt(
    driver,
    driver.assignedVehicle,
    new Date(),
    thresholds,
  );

  const [sharers, futureJobs, earnings] = await Promise.all([
    driver.assignedVehicleId
      ? findVehicleSharers(driver.assignedVehicleId, driver.id)
      : Promise.resolve([]),
    findFutureJobs(driver.id),
    prisma.jobFinance.aggregate({
      where: { job: { driverId: driver.id, status: 'COMPLETED' } },
      _sum: { driverPaymentPence: true },
    }),
  ]);

  const maySeeMoney = can(user, 'viewRevenue');
  const isDeactivated = driver.status !== 'ACTIVE';

  return (
    <>
      <PageHeader
        title={driver.name}
        description={`${driver.reference} · ${driver.phone}`}
        actions={
          <div className="flex items-center gap-2">
            <ComplianceBadge level={compliance.level} />
            {driver.status !== 'ACTIVE' ? (
              <Badge
                variant={
                  driver.status === 'SUSPENDED' ? 'destructive' : 'secondary'
                }
              >
                {driver.status === 'SUSPENDED' ? 'Suspended' : 'Inactive'}
              </Badge>
            ) : null}
            {can(user, 'editDrivers') ? (
              <Button asChild variant="outline">
                <Link href={`/drivers/${driver.id}/edit`}>
                  <Pencil aria-hidden />
                  Edit
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {!compliance.compliant ? (
        <Card className="mb-4 border-destructive/50 bg-destructive/5">
          <CardContent className="p-4 text-sm">
            <p className="font-medium text-destructive">
              This driver cannot be assigned to a job
            </p>
            <ul className="mt-1 list-inside list-disc text-muted-foreground">
              {compliance.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Warns, never blocks: relief drivers sharing a car is legitimate. */}
      {sharers.length > 0 ? (
        <Card className="mb-4 border-warning/50 bg-warning/10">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">
                {driver.assignedVehicle?.registration} is also assigned to{' '}
                {sharers.length === 1 ? 'another active driver' : 'other active drivers'}
              </p>
              <p className="text-muted-foreground">
                {sharers.map((s) => s.name).join(', ')} — fine for relief cover,
                worth checking otherwise.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* The other warn-don't-block case, per the spec. */}
      {isDeactivated && futureJobs.length > 0 ? (
        <Card className="mb-4 border-warning/50 bg-warning/10">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">
                This driver is {driver.status.toLowerCase()} but still holds{' '}
                {futureJobs.length} upcoming job
                {futureJobs.length === 1 ? '' : 's'}
              </p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {futureJobs.slice(0, 5).map((job) => (
                  <li key={job.id}>
                    <Link href={`/jobs/${job.id}`} className="underline tabular">
                      {job.reference}
                    </Link>{' '}
                    · {formatDateTime(job.scheduledAt)} · {job.pickupText} →{' '}
                    {job.dropoffText}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Compliance</CardTitle>
          </CardHeader>
          <CardContent>
            <ComplianceItems items={compliance.items} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Email" value={driver.email} />
            <Row label="Address" value={driver.address} />
            <Row label="DVLA licence" value={driver.dvlaLicenceNumber} />
            <Row label="PHV badge" value={driver.phvBadgeNumber} />
            <Row label="Issuing authority" value={driver.phvIssuingAuthority} />
            <div>
              <p className="text-muted-foreground">Assigned vehicle</p>
              {driver.assignedVehicle ? (
                <Link
                  href={`/vehicles/${driver.assignedVehicle.id}`}
                  className="tabular hover:underline"
                >
                  {driver.assignedVehicle.registration}
                </Link>
              ) : (
                <p className="text-muted-foreground">None</p>
              )}
            </div>
            <Row
              label="Telegram"
              value={
                driver.telegramLinkedAt
                  ? `Linked ${formatDate(driver.telegramLinkedAt)}`
                  : 'Not linked — arrives in Phase 5'
              }
            />
            {maySeeMoney ? (
              <div>
                <p className="text-muted-foreground">Paid to date</p>
                <p className="text-lg font-semibold tabular">
                  {formatGBP(earnings._sum.driverPaymentPence ?? 0)}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {driver.notes ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">
            {driver.notes}
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6">
        <DocumentPanel
          owner={{ driverId: driver.id }}
          returnPath={`/drivers/${driver.id}`}
          canUpload={can(user, 'editDocuments')}
          canDelete={can(user, 'deleteRecords')}
          storageConfigured={isStorageConfigured()}
          types={DOCUMENT_TYPES.filter(
            (t) => t.scope === 'driver' || t.scope === 'both',
          ).map((t) => ({
            value: t.value,
            label: t.label,
            requiresExpiry: requiresExpiry(t.value),
          }))}
          documents={driver.documents.map((document) => ({
            id: document.id,
            type: document.type,
            typeLabel: documentLabel(document.type),
            fileName: document.fileName,
            sizeBytes: document.sizeBytes,
            expiresOn: document.expiresOn
              ? toDateOnlyString(document.expiresOn)
              : null,
            uploadedAt: formatDate(document.uploadedAt),
            requiresExpiry: requiresExpiry(document.type),
          }))}
        />
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={value ? '' : 'text-muted-foreground'}>{value ?? '—'}</p>
    </div>
  );
}
