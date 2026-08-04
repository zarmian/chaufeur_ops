import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { createVehicleAction } from '../actions';
import { VehicleForm } from '../vehicle-form';

export const metadata = { title: 'New vehicle' };

export default async function NewVehiclePage() {
  await pageRequireCapability('editVehicles');

  return (
    <>
      <PageHeader
        title="New vehicle"
        description="Record the expiry dates now — a vehicle without them cannot be assigned to a job."
      />
      <VehicleForm
        action={createVehicleAction}
        submitLabel="Add vehicle"
        cancelHref="/vehicles"
      />
    </>
  );
}
