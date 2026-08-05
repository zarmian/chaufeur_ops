'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';
import { openShift, openShiftSchema } from '@/lib/shift-store';

export async function openShiftAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editDrivers');
    const result = await openShift(
      openShiftSchema.parse({
        driverId: formData.get('driverId') ?? '',
        vehicleId: formData.get('vehicleId') ?? '',
        startedAt: formData.get('startedAt') ?? '',
        breakMinutes: formData.get('breakMinutes') ?? 0,
        hourlyRatePence: formData.get('hourlyRatePence') ?? '',
        notes: formData.get('notes') ?? '',
      }),
      audit,
    );
    // "That driver already has a shift open" is something to fix, not a fault.
    if (!result.ok) return { error: result.message };
    id = result.id;
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/shifts');
  redirect(`/shifts/${id}`);
}
