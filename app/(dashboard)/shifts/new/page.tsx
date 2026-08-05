import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { openShiftAction } from '../actions';
import { ShiftForm } from '../shift-form';

export const metadata = { title: 'Start a shift' };

export default async function NewShiftPage() {
  await pageRequireCapability('editDrivers');

  const [drivers, vehicles] = await Promise.all([
    prisma.driver.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, reference: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.vehicle.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, registration: true, make: true, model: true },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Start a shift"
        description="The hourly rate is copied onto the shift now. A later rate change will not re-price it."
      />
      <ShiftForm
        action={openShiftAction}
        cancelHref="/shifts"
        drivers={drivers.map((d) => ({ id: d.id, label: `${d.name} · ${d.reference}` }))}
        vehicles={vehicles.map((v) => ({
          id: v.id,
          label: `${v.registration} · ${v.make} ${v.model}`,
        }))}
      />
    </>
  );
}
