import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getContract } from '@/lib/contracts';
import { toDateOnlyString } from '@/lib/dates';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { updateContractAction } from '../../actions';
import { ContractForm } from '../../contract-form';

export const metadata = { title: 'Edit contract' };

const asMoneyInput = (pence: number | null | undefined) =>
  pence === null || pence === undefined ? '' : (pence / 100).toFixed(2);

export default async function EditContractPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editJobs');
  const { id } = await params;

  const contract = await getContract(id);
  if (!contract) notFound();

  const [clients, accounts, drivers, vehicles, locale] = await Promise.all([
    prisma.client.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.account.findMany({
      where: { OR: [{ active: true }, { id: contract.accountId ?? '' }] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.driver.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { id: contract.driverId ?? '' }] },
      select: { id: true, name: true, reference: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.vehicle.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { id: contract.vehicleId ?? '' }] },
      select: { id: true, registration: true, make: true, model: true },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
    getLocaleConfig(),
  ]);

  return (
    <>
      <PageHeader
        title={`Edit ${contract.label}`}
        description={contract.reference}
      />

      {/* Said before anything is typed. The rule is the same one series
          follow: generation makes independent jobs, and reaching back into
          them would undo work somebody did on purpose. */}
      <Alert className="mb-6">
        <AlertDescription>
          Changes apply to days created from now on. Days already booked keep
          the driver and the times they were given — change those on the jobs
          themselves. A changed <strong>rate</strong> is the exception: you can
          apply it back over days already booked, further down.
        </AlertDescription>
      </Alert>

      <ContractForm
        action={updateContractAction.bind(null, contract.id)}
        submitLabel="Save changes"
        offerReprice
        cancelHref={`/contracts/${contract.id}`}
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
          label: contract.label,
          clientId: contract.clientId ?? '',
          accountId: contract.accountId ?? '',
          pickupText: contract.pickupText,
          dropoffText: contract.dropoffText,
          viaText: contract.viaText ?? '',
          startTime: contract.startTime,
          estimatedMinutes:
            contract.estimatedMinutes === null
              ? ''
              : String(contract.estimatedMinutes),
          passengerName: contract.passengerName ?? '',
          passengerPhone: contract.passengerPhone ?? '',
          driverId: contract.driverId ?? '',
          vehicleId: contract.vehicleId ?? '',
          weekdays: contract.weekdays,
          startsOn: toDateOnlyString(contract.startsOn),
          endsOn: contract.endsOn ? toDateOnlyString(contract.endsOn) : '',
          dayRate: asMoneyInput(contract.dayRatePence),
          driverDayRate: asMoneyInput(contract.driverDayRatePence),
          vatTreatment: contract.vatTreatment ?? '',
          generateAheadDays: String(contract.generateAheadDays),
          notes: contract.notes ?? '',
        }}
      />
    </>
  );
}
