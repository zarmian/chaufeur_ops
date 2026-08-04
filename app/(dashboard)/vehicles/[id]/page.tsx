import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ComplianceBadge, ComplianceItems } from '@/components/compliance-badge';
import { DocumentPanel } from '@/components/documents/document-panel';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { can } from '@/lib/authz';
import { vehicleComplianceAt } from '@/lib/compliance';
import { formatDate, formatDateTime, toDateOnlyString } from '@/lib/dates';
import { DOCUMENT_TYPES, documentLabel, requiresExpiry } from '@/lib/documents';
import { pageRequireCapability } from '@/lib/page-guards';
import { getComplianceThresholds } from '@/lib/settings';
import { isStorageConfigured } from '@/lib/storage';
import { getVehicle } from '@/lib/vehicles';

export const metadata = { title: 'Vehicle' };

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const { id } = await params;

  const vehicle = await getVehicle(id);
  if (!vehicle) notFound();

  const thresholds = await getComplianceThresholds();
  const compliance = vehicleComplianceAt(vehicle, new Date(), thresholds);

  return (
    <>
      <PageHeader
        title={vehicle.registration}
        description={`${vehicle.make} ${vehicle.model}${vehicle.variant ? ` ${vehicle.variant}` : ''} · ${vehicle.seats} seats`}
        actions={
          <div className="flex items-center gap-2">
            <ComplianceBadge level={compliance.level} />
            {can(user, 'editVehicles') ? (
              <Button asChild variant="outline">
                <Link href={`/vehicles/${vehicle.id}/edit`}>
                  <Pencil aria-hidden />
                  Edit
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {!compliance.compliant ? (
        <Card className="mb-6 border-destructive/50 bg-destructive/5">
          <CardContent className="p-4 text-sm">
            <p className="font-medium text-destructive">
              This vehicle cannot be assigned to a job
            </p>
            <ul className="mt-1 list-inside list-disc text-muted-foreground">
              {compliance.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
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
            <Row label="Class" value={vehicle.vehicleClass.replace('_', ' ').toLowerCase()} />
            <Row label="Colour" value={vehicle.colour} />
            <Row label="Status" value={vehicle.status.replace('_', ' ').toLowerCase()} />
            <Row label="PHV licence number" value={vehicle.phvLicenceNumber} />
            <Row label="Insurance policy" value={vehicle.insurancePolicyNo} />
            <div>
              <p className="text-muted-foreground">Assigned drivers</p>
              {vehicle.drivers.length === 0 ? (
                <p className="text-muted-foreground">None</p>
              ) : (
                <ul>
                  {vehicle.drivers.map((driver) => (
                    <li key={driver.id}>
                      <Link href={`/drivers/${driver.id}`} className="hover:underline">
                        {driver.name}
                      </Link>{' '}
                      <span className="tabular text-muted-foreground">
                        {driver.reference}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Row label="Added" value={formatDateTime(vehicle.createdAt)} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <DocumentPanel
          owner={{ vehicleId: vehicle.id }}
          returnPath={`/vehicles/${vehicle.id}`}
          canUpload={can(user, 'editDocuments')}
          canDelete={can(user, 'deleteRecords')}
          storageConfigured={isStorageConfigured()}
          types={DOCUMENT_TYPES.filter(
            (t) => t.scope === 'vehicle' || t.scope === 'both',
          ).map((t) => ({
            value: t.value,
            label: t.label,
            requiresExpiry: requiresExpiry(t.value),
          }))}
          documents={vehicle.documents.map((document) => ({
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
      <p className={value ? 'capitalize' : 'text-muted-foreground'}>
        {value ?? '—'}
      </p>
    </div>
  );
}
