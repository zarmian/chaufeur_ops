import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { createRentalAction } from '../actions';
import { RentalForm } from '../rental-form';

export const metadata = { title: 'New rental' };

export default async function NewRentalPage() {
  await pageRequireCapability('editVehicles');

  const [vehicles, drivers] = await Promise.all([
    prisma.vehicle.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, registration: true, make: true, model: true },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
    prisma.driver.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, reference: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  ]);

  return (
    <>
      <PageHeader
        title="New rental"
        description="A car out on rent cannot be put on a job for the same period."
      />
      <RentalForm
        action={createRentalAction}
        cancelHref="/rentals"
        vehicles={vehicles.map((v) => ({
          id: v.id,
          label: `${v.registration} · ${v.make} ${v.model}`,
        }))}
        drivers={drivers.map((d) => ({
          id: d.id,
          label: `${d.name} · ${d.reference}`,
        }))}
      />
    </>
  );
}
