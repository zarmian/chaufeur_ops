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
      driverId: formData.get('driverId') ?? '',
      startAt: formData.get('startAt') ?? '',
      endAt: formData.get('endAt') ?? '',
      rateType: formData.get('rateType') ?? 'DAILY',
      ratePence: formData.get('rate') ?? '',
      depositPence: formData.get('deposit') ?? '',
      mileageOut: formData.get('mileageOut') ?? '',
      fuelOutPct: formData.get('fuelOutPct') ?? '',
      notes: formData.get('notes') ?? '',
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
