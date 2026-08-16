import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ComplianceBadge, ComplianceItems } from '@/components/compliance-badge';
import { DocumentPanel } from '@/components/documents/document-panel';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ProfitFigures,
  ServiceBadge,
  WindowPicker,
} from '@/components/vehicle-profit';
import { can } from '@/lib/authz';
import { vehicleComplianceAt } from '@/lib/compliance';
import { formatDate, formatDateTime, toDateOnlyString } from '@/lib/dates';
import { DOCUMENT_TYPES, documentLabel, requiresExpiry } from '@/lib/documents';
import { getVehicleCosts, vehicleProfit } from '@/lib/fleet';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { getComplianceThresholds } from '@/lib/settings';
import { isStorageConfigured } from '@/lib/storage';
import { companyBearsCosts, OWNERSHIP_LABELS } from '@/lib/vehicle-costs';
import { parsePnlWindow, windowToInputs } from '@/lib/vehicle-pnl';
import { getVehicle } from '@/lib/vehicles';
import { CostsPanel } from './costs-panel';

export const metadata = { title: 'Vehicle' };

export default async function VehicleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const { id } = await params;
  const query = await searchParams;

  const vehicle = await getVehicle(id);
  if (!vehicle) notFound();

  const thresholds = await getComplianceThresholds();
  const compliance = vehicleComplianceAt(vehicle, new Date(), thresholds);

  const window = parsePnlWindow(
    filterValue(query, 'from'),
    filterValue(query, 'to'),
  );
  const inputs = windowToInputs(window);

  const [{ costs, standing, service }, profit] = await Promise.all([
    getVehicleCosts(vehicle.id),
    vehicleProfit(vehicle.id, window),
  ]);

  const companyOwned = companyBearsCosts(vehicle.ownership);
  // The finance or lease agreement still running, out of the standing costs
  // already loaded. An ended one stays in the list below, where its months of
  // accrued cost belong, but it is not what the car costs today.
  const agreement =
    standing.find(
      (cost) =>
        (cost.kind === 'FINANCE' || cost.kind === 'LEASE') &&
        (cost.endsOn === null || cost.endsOn >= new Date()),
    ) ?? null;
  const mayEditCosts = can(user, 'editJobFinances');
  const costError = filterValue(query, 'costError');

  return (
    <>
      <PageHeader
        title={vehicle.registration}
        description={`${vehicle.make} ${vehicle.model}${vehicle.variant ? ` ${vehicle.variant}` : ''} · ${vehicle.seats} seats · ${OWNERSHIP_LABELS[vehicle.ownership]}`}
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

      {/* Separate from the block above on purpose. A lapsed MOT is illegal and
          stops the car; an overdue service is a decision the operator makes.
          Merging them would either block legal work or quietly soften the
          checks that are not negotiable. */}
      {service?.due ? (
        <Card className="mb-6 border-warning/50 bg-warning/5">
          <CardContent className="p-4 text-sm">
            <p className="font-medium">{service.reason}</p>
            <p className="text-muted-foreground">
              This does not stop the car being assigned. Recording a service
              cost below clears it.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Compliance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ComplianceItems items={compliance.items} />
            {companyOwned && service && !service.due ? (
              <div className="border-t pt-3">
                <ServiceBadge
                  due={false}
                  daysRemaining={service.daysRemaining}
                  milesRemaining={service.milesRemaining}
                />
              </div>
            ) : null}
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
            <div>
              <p className="text-muted-foreground">Held as</p>
              <p>
                {OWNERSHIP_LABELS[vehicle.ownership]}
                {vehicle.ownerDriver ? (
                  <>
                    {' · '}
                    <Link
                      href={`/drivers/${vehicle.ownerDriver.id}`}
                      className="hover:underline"
                    >
                      {vehicle.ownerDriver.name}
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
            {companyOwned ? (
              <>
                <Row
                  label="Acquired"
                  value={vehicle.acquiredOn ? formatDate(vehicle.acquiredOn) : null}
                />
                {/* A leased car has no purchase price — it has a payment, and
                    that payment is what it costs to hold. Showing the price
                    field on one is asking a question with no answer. */}
                {agreement ? (
                  <Row
                    label={
                      agreement.kind === 'LEASE' ? 'Lease payment' : 'Finance payment'
                    }
                    value={`${formatGBP(agreement.amountPence)}${
                      agreement.periodMonths === 1
                        ? ' a month'
                        : ` every ${agreement.periodMonths} months`
                    }${agreement.endsOn ? `, until ${formatDate(agreement.endsOn)}` : ''}`}
                  />
                ) : (
                  <Row
                    label="Purchase price"
                    value={
                      vehicle.purchasePricePence === null
                        ? null
                        : formatGBP(vehicle.purchasePricePence)
                    }
                  />
                )}
                <Row
                  label="Odometer"
                  value={
                    vehicle.currentOdometer === null
                      ? null
                      : `${vehicle.currentOdometer.toLocaleString()} miles`
                  }
                />
                <Row
                  label="Last serviced"
                  value={
                    vehicle.lastServicedOn
                      ? `${formatDate(vehicle.lastServicedOn)}${
                          vehicle.lastServiceMiles !== null
                            ? ` at ${vehicle.lastServiceMiles.toLocaleString()} miles`
                            : ''
                        }`
                      : null
                  }
                />
                {vehicle.disposedOn ? (
                  <div>
                    <p className="text-muted-foreground">Disposed of</p>
                    <p>
                      <Badge variant="secondary">
                        {formatDate(vehicle.disposedOn)}
                      </Badge>
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}
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

      <Card className="mt-6" id="profit">
        <CardHeader>
          <CardTitle className="text-base">
            {companyOwned ? 'Profit' : 'What this car earns us'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WindowPicker
            action={`/vehicles/${vehicle.id}`}
            from={inputs.from}
            to={inputs.to}
          />
          {profit ? (
            <ProfitFigures
              pnl={profit.pnl}
              jobCount={profit.jobCount}
              rentalCount={profit.rentalCount}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-6" id="costs">
        <CardHeader>
          <CardTitle className="text-base">Running costs</CardTitle>
        </CardHeader>
        <CardContent>
          <CostsPanel
            vehicleId={vehicle.id}
            companyOwned={companyOwned}
            ownerName={vehicle.ownerDriver?.name ?? null}
            mayEdit={mayEditCosts}
            // A garage invoice shows what the company pays its suppliers,
            // which is finance's business rather than every dispatcher's.
            mayViewReceipts={can(user, 'viewInvoices')}
            storageConfigured={isStorageConfigured()}
            error={costError}
            today={toDateOnlyString(new Date())}
            costs={costs}
            standing={standing}
          />
        </CardContent>
      </Card>

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
