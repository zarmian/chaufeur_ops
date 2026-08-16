'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { createRental, rentalSchema } from '@/lib/rental-store';
import { actingUser } from '@/lib/request-context';

export async function createRentalAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editVehicles');
    const parsed = rentalSchema.parse({
      vehicleId: formData.get('vehicleId') ?? '',
      renterType: formData.get('renterType') ?? 'DRIVER',
      driverId: formData.get('driverId') ?? '',
      accountId: formData.get('accountId') ?? '',
      hirerName: formData.get('hirerName') ?? '',
      hirerAddress: formData.get('hirerAddress') ?? '',
      hirerPhone: formData.get('hirerPhone') ?? '',
      hirerLicenceNumber: formData.get('hirerLicenceNumber') ?? '',
      saveHirerAsAccount: formData.get('saveHirerAsAccount') === 'true',
      startAt: formData.get('startAt') ?? '',
      endAt: formData.get('endAt') ?? '',
      rateType: formData.get('rateType') ?? 'DAILY',
      ratePence: formData.get('rate') ?? '',
      depositPence: formData.get('deposit') ?? '',
      mileageOut: formData.get('mileageOut') ?? '',
      fuelOutPct: formData.get('fuelOutPct') ?? '',
      notes: formData.get('notes') ?? '',
      mileageAllowancePerDay: formData.get('mileageAllowancePerDay') ?? '',
      excessMileagePence: formData.get('excessMileagePence') ?? '',
      advancePaymentPence: formData.get('advancePaymentPence') ?? '',
      minimumTermDays: formData.get('minimumTermDays') ?? '',
      insuranceExcessPence: formData.get('insuranceExcessPence') ?? '',
      congestionChargePence: formData.get('congestionChargePence') ?? '',
      smokingChargePence: formData.get('smokingChargePence') ?? '',
      panelRepairPence: formData.get('panelRepairPence') ?? '',
      wheelScratchPence: formData.get('wheelScratchPence') ?? '',
      depositReturnDays: formData.get('depositReturnDays') ?? '',
      ownerSignatory: formData.get('ownerSignatory') ?? '',
    });

    const result = await createRental(parsed, audit);
    // A double-booking is information the operator can act on — there is only
    // one car — not a fault for the error boundary.
    if (!result.ok) return { error: result.message };
    id = result.id;
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/rentals');
  redirect(`/rentals/${id}`);
}
