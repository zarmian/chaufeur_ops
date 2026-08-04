import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { toDateOnlyString } from '@/lib/dates';
import { pageRequireCapability } from '@/lib/page-guards';
import { getVehicle } from '@/lib/vehicles';
import { updateVehicleAction } from '../../actions';
import { VehicleForm } from '../../vehicle-form';

export const metadata = { title: 'Edit vehicle' };

const asDateInput = (value: Date | null) =>
  value ? toDateOnlyString(value) : '';

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editVehicles');
  const { id } = await params;

  const vehicle = await getVehicle(id);
  if (!vehicle) notFound();

  return (
    <>
      <PageHeader title={`Edit ${vehicle.registration}`} />
      <VehicleForm
        action={updateVehicleAction.bind(null, vehicle.id)}
        submitLabel="Save changes"
        cancelHref={`/vehicles/${vehicle.id}`}
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
        }}
      />
    </>
  );
}
