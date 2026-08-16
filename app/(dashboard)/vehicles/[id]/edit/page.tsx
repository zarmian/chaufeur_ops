import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { toDateOnlyString } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import {
  getVehicle,
  listDriverOptions,
  openFinanceAgreement,
} from '@/lib/vehicles';
import { updateVehicleAction } from '../../actions';
import { VehicleForm } from '../../vehicle-form';

export const metadata = { title: 'Edit vehicle' };

const asDateInput = (value: Date | null) =>
  value ? toDateOnlyString(value) : '';

const asNumberInput = (value: number | null) =>
  value === null ? '' : String(value);

// Bare, so the field reads 34500.00 rather than £34,500.00 — it posts
// straight back through `parseMoney`.
const asMoneyInput = (pence: number | null) =>
  pence === null ? '' : formatMoney(pence, { bare: true }).replace(/,/g, '');

/**
 * The provider back out of a standing cost's label.
 *
 * The label is what the costs panel shows, so it reads "Lease — Arval" rather
 * than carrying a separate column nothing else would use. Splitting on the
 * dash is enough, and a label somebody typed by hand simply yields nothing.
 */
function providerFrom(label: string | null): string {
  if (!label) return '';
  const [, provider] = label.split(' — ');
  return provider?.trim() ?? '';
}

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editVehicles');
  const { id } = await params;

  const vehicle = await getVehicle(id);
  if (!vehicle) notFound();

  // The agreement still running on the car, if any. An expired one is left
  // alone: the months it covered are real cost, and the form edits only what
  // is in force.
  const [drivers, agreement] = await Promise.all([
    listDriverOptions(),
    openFinanceAgreement(vehicle.id),
  ]);

  return (
    <>
      <PageHeader title={`Edit ${vehicle.registration}`} />
      <VehicleForm
        action={updateVehicleAction.bind(null, vehicle.id)}
        submitLabel="Save changes"
        cancelHref={`/vehicles/${vehicle.id}`}
        drivers={drivers}
        values={{
          registration: vehicle.registration,
          make: vehicle.make,
          model: vehicle.model,
          variant: vehicle.variant ?? '',
          vehicleClass: vehicle.vehicleClass,
          colour: vehicle.colour ?? '',
          seats: vehicle.seats,
          phvLicenceNumber: vehicle.phvLicenceNumber ?? '',
          phvLicenceExpiry: asDateInput(vehicle.phvLicenceExpiry),
          motExpiry: asDateInput(vehicle.motExpiry),
          insuranceExpiry: asDateInput(vehicle.insuranceExpiry),
          insurancePolicyNo: vehicle.insurancePolicyNo ?? '',
          insurerName: vehicle.insurerName ?? '',
          chassisNumber: vehicle.chassisNumber ?? '',
          firstRegisteredOn: asDateInput(vehicle.firstRegisteredOn),
          valuePence: vehicle.valuePence == null ? '' : (vehicle.valuePence / 100).toFixed(2),
          status: vehicle.status,
          ownership: vehicle.ownership,
          ownerDriverId: vehicle.ownerDriverId ?? '',
          acquiredOn: asDateInput(vehicle.acquiredOn),
          disposedOn: asDateInput(vehicle.disposedOn),
          purchasePrice: asMoneyInput(vehicle.purchasePricePence),
          financePayment: asMoneyInput(agreement?.amountPence ?? null),
          financePeriodMonths: asNumberInput(agreement?.periodMonths ?? null),
          financeStartsOn: asDateInput(agreement?.startsOn ?? null),
          financeEndsOn: asDateInput(agreement?.endsOn ?? null),
          // The provider is stored as part of the label — "Lease — Arval".
          financeProvider: providerFrom(agreement?.label ?? null),
          currentOdometer: asNumberInput(vehicle.currentOdometer),
          lastServicedOn: asDateInput(vehicle.lastServicedOn),
          lastServiceMiles: asNumberInput(vehicle.lastServiceMiles),
          serviceEveryMonths: asNumberInput(vehicle.serviceEveryMonths),
          serviceEveryMiles: asNumberInput(vehicle.serviceEveryMiles),
        }}
      />
    </>
  );
}
