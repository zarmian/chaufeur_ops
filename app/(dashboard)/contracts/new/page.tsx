import { PageHeader } from '@/components/page-header';
import { toDateOnlyString } from '@/lib/dates';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { createContractAction } from '../actions';
import { ContractForm } from '../contract-form';

export const metadata = { title: 'New contract' };

export default async function NewContractPage() {
  await pageRequireCapability('editJobs');

  const [clients, accounts, drivers, vehicles, locale] = await Promise.all([
    prisma.client.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.account.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
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
    getLocaleConfig(),
  ]);

  return (
    <>
      <PageHeader
        title="New contract"
        description="A job is created for each day it runs, a couple of weeks ahead. The driver and the car stay free for other work."
      />
      <ContractForm
        action={createContractAction}
        submitLabel="Start the contract"
        cancelHref="/contracts"
        currency={locale.currency}
        locale={locale.locale}
        clients={clients.map((c) => ({ id: c.id, label: c.name }))}
        accounts={accounts.map((a) => ({ id: a.id, label: a.name }))}
        drivers={drivers.map((d) => ({ id: d.id, label: `${d.name} · ${d.reference}` }))}
        vehicles={vehicles.map((v) => ({
          id: v.id,
          label: `${v.registration} · ${v.make} ${v.model}`,
        }))}
        values={{
          label: '',
          clientId: '',
          accountId: '',
          pickupText: '',
          dropoffText: '',
          viaText: '',
          startTime: '09:00',
          estimatedMinutes: '',
          passengerName: '',
          passengerPhone: '',
          driverId: '',
          vehicleId: '',
          // Weekdays, because that is what most standing arrangements are.
          weekdays: [1, 2, 3, 4, 5],
          startsOn: toDateOnlyString(new Date()),
          endsOn: '',
          dayRate: '',
          driverDayRate: '',
          vatTreatment: '',
          generateAheadDays: '14',
          notes: '',
        }}
      />
    </>
  );
}
