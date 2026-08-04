import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { toDateOnlyString } from '@/lib/dates';
import { getDriver } from '@/lib/drivers';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { updateDriverAction } from '../../actions';
import { DriverForm } from '../../driver-form';

export const metadata = { title: 'Edit driver' };

const asDateInput = (value: Date | null) =>
  value ? toDateOnlyString(value) : '';

export default async function EditDriverPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editDrivers');
  const { id } = await params;

  const [driver, vehicles] = await Promise.all([
    getDriver(id),
    prisma.vehicle.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, registration: true, make: true, model: true },
      orderBy: { registration: 'asc' },
    }),
  ]);
  if (!driver) notFound();

  return (
    <>
      <PageHeader
        title={`Edit ${driver.name}`}
        description={`Reference ${driver.reference} — fixed once allocated.`}
      />
      <DriverForm
        action={updateDriverAction.bind(null, driver.id)}
        submitLabel="Save changes"
        cancelHref={`/drivers/${driver.id}`}
        vehicles={vehicles.map((v) => ({
          id: v.id,
          registration: v.registration,
          label: `${v.registration} · ${v.make} ${v.model}`,
        }))}
        values={{
          name: driver.name,
          phone: driver.phone,
          email: driver.email ?? '',
          address: driver.address ?? '',
          dvlaLicenceNumber: driver.dvlaLicenceNumber ?? '',
          dvlaLicenceExpiry: asDateInput(driver.dvlaLicenceExpiry),
          phvBadgeNumber: driver.phvBadgeNumber ?? '',
          phvBadgeExpiry: asDateInput(driver.phvBadgeExpiry),
          phvIssuingAuthority: driver.phvIssuingAuthority ?? '',
          assignedVehicleId: driver.assignedVehicleId ?? '',
          status: driver.status,
          notes: driver.notes ?? '',
        }}
      />
    </>
  );
}
