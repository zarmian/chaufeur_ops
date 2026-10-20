import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { recordShiftAction } from '../actions';
import { ShiftForm } from '../shift-form';

/**
 * A shift entered after it was worked.
 *
 * Its own page rather than a mode on "Start a shift", because the two are
 * different acts with different failure modes. Clocking on is refused when
 * the driver already has a shift open; recording is refused when those hours
 * are already on another shift — and that second check only exists because
 * this page does. Until now a shift could only be created at the moment it
 * began, and the one-open-shift rule stood in for an overlap check.
 */

export const metadata = { title: 'Record a shift' };

export default async function RecordShiftPage() {
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
        title="Record a shift"
        description="Hours already worked. The rate is the driver's engagement rate on the day the shift started, not today's."
      />
      <ShiftForm
        action={recordShiftAction}
        worked
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
