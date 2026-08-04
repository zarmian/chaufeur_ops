import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { peekNextDriverReference } from '@/lib/references';
import { createDriverAction } from '../actions';
import { DriverForm } from '../driver-form';

export const metadata = { title: 'New driver' };

export default async function NewDriverPage() {
  await pageRequireCapability('editDrivers');

  const [vehicles, nextReference] = await Promise.all([
    prisma.vehicle.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, registration: true, make: true, model: true },
      orderBy: { registration: 'asc' },
    }),
    peekNextDriverReference(),
  ]);

  return (
    <>
      <PageHeader
        title="New driver"
        description="Record the licence and badge expiry dates now — without them the driver cannot be put on a job."
      />
      <DriverForm
        action={createDriverAction}
        submitLabel="Add driver"
        cancelHref="/drivers"
        nextReference={nextReference}
        vehicles={vehicles.map((v) => ({
          id: v.id,
          registration: v.registration,
          label: `${v.registration} · ${v.make} ${v.model}`,
        }))}
      />
    </>
  );
}
