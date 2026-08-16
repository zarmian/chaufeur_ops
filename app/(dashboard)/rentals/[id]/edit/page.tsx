import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toLondon } from '@/lib/dates';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { getRental, rentalEditability } from '@/lib/rental-store';
import { updateRentalAction } from '../../actions';
import { RentalForm } from '../../rental-form';

export const metadata = { title: 'Edit rental' };

/** Pence as the text input holds it — "80.00", which is what the schema parses. */
const asMoneyInput = (pence: number | null | undefined) =>
  pence === null || pence === undefined ? '' : (pence / 100).toFixed(2);

const asNumberInput = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : String(value);

export default async function EditRentalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editVehicles');
  const { id } = await params;

  const rental = await getRental(id);
  if (!rental) notFound();

  const [vehicles, drivers, accounts, editable] = await Promise.all([
    prisma.vehicle.findMany({
      // The car this hire is already on is included even if it has since been
      // taken off the road — otherwise opening the form would silently blank
      // the vehicle and the first save would lose it.
      where: { OR: [{ status: 'ACTIVE' }, { id: rental.vehicle.id }] },
      select: { id: true, registration: true, make: true, model: true },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
    prisma.driver.findMany({
      where: {
        OR: [
          { status: 'ACTIVE' },
          ...(rental.driver ? [{ id: rental.driver.id }] : []),
        ],
      },
      select: { id: true, name: true, reference: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.account.findMany({
      where: {
        OR: [{ active: true }, ...(rental.account ? [{ id: rental.account.id }] : [])],
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    rentalEditability(rental.id),
  ]);

  return (
    <>
      <PageHeader
        title={`Edit ${rental.reference}`}
        description={`${rental.vehicle.registration} · booked ${rental.status.toLowerCase()}`}
      />

      {/* Said before anything is typed rather than after it is submitted. A
          hire that has been billed is a figure on a document the client is
          holding, and the remedy is a credit note, not an edit here. */}
      {!editable.ok ? (
        <Alert variant="destructive" className="mb-6" data-testid="rental-locked">
          <AlertDescription>{editable.message}</AlertDescription>
        </Alert>
      ) : null}

      {rental.returnedAt ? (
        <Alert className="mb-6">
          <AlertDescription>
            This car has already been booked back in. The return mileage, fuel
            and damage are recorded on the hire itself — this form covers what
            was agreed when it went out.
          </AlertDescription>
        </Alert>
      ) : null}

      <RentalForm
        action={updateRentalAction.bind(null, rental.id)}
        submitLabel="Save changes"
        offerToSaveHirer={false}
        cancelHref={`/rentals/${rental.id}`}
        vehicles={vehicles.map((v) => ({
          id: v.id,
          label: `${v.registration} · ${v.make} ${v.model}`,
        }))}
        drivers={drivers.map((d) => ({
          id: d.id,
          label: `${d.name} · ${d.reference}`,
        }))}
        accounts={accounts.map((a) => ({ id: a.id, label: a.name }))}
        values={{
          vehicleId: rental.vehicle.id,
          renterType: rental.renterType,
          driverId: rental.driver?.id ?? '',
          accountId: rental.account?.id ?? '',
          hirerName: rental.hirerName ?? '',
          hirerAddress: rental.hirerAddress ?? '',
          hirerPhone: rental.hirerPhone ?? '',
          hirerLicenceNumber: rental.hirerLicenceNumber ?? '',
          startAt: toLondon(rental.startAt),
          endAt: toLondon(rental.endAt),
          rateType: rental.rateType,
          rate: asMoneyInput(rental.ratePence),
          deposit: asMoneyInput(rental.depositPence),
          mileageOut: asNumberInput(rental.mileageOut),
          fuelOutPct: asNumberInput(rental.fuelOutPct),
          advancePayment: asMoneyInput(rental.advancePaymentPence),
          notes: rental.notes ?? '',
        }}
        // The terms this contract actually says, not the last hire's. A
        // reprinted agreement has to match the one that was signed.
        defaults={{
          mileageAllowancePerDay: rental.mileageAllowancePerDay,
          minimumTermDays: rental.minimumTermDays,
          depositReturnDays: rental.depositReturnDays,
          excessMileage: asMoneyInput(rental.excessMileagePence) || null,
          insuranceExcess: asMoneyInput(rental.insuranceExcessPence) || null,
          congestionCharge: asMoneyInput(rental.congestionChargePence) || null,
          smokingCharge: asMoneyInput(rental.smokingChargePence) || null,
          panelRepair: asMoneyInput(rental.panelRepairPence) || null,
          wheelScratch: asMoneyInput(rental.wheelScratchPence) || null,
          ownerSignatory: rental.ownerSignatory,
        }}
      />
    </>
  );
}
