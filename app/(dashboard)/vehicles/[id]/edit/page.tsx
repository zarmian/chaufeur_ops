import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { toDateOnlyString } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { getVehicle, listDriverOptions } from '@/lib/vehicles';
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

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editVehicles');
  const { id } = await params;

  const vehicle = await getVehicle(id);
  if (!vehicle) notFound();

  const drivers = await listDriverOptions();

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
          status: vehicle.status,
          ownership: vehicle.ownership,
          ownerDriverId: vehicle.ownerDriverId ?? '',
          acquiredOn: asDateInput(vehicle.acquiredOn),
          disposedOn: asDateInput(vehicle.disposedOn),
          purchasePrice: asMoneyInput(vehicle.purchasePricePence),
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
