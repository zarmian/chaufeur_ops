'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';
import {
  openShift,
  openShiftSchema,
  recordShift,
  recordShiftSchema,
} from '@/lib/shift-store';

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

/**
 * Enter a shift that has already been worked.
 *
 * Its own action rather than a flag on `openShiftAction`, because the two
 * refusals are different and the operator has to be told which applies:
 * opening is blocked by the driver already being clocked on, recording is
 * blocked by the hours already being on another shift.
 */
export async function recordShiftAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editDrivers');
    const result = await recordShift(
      recordShiftSchema.parse({
        driverId: formData.get('driverId') ?? '',
        vehicleId: formData.get('vehicleId') ?? '',
        startedAt: formData.get('startedAt') ?? '',
        endedAt: formData.get('endedAt') ?? '',
        breakMinutes: formData.get('breakMinutes') ?? 0,
        hourlyRatePence: formData.get('hourlyRatePence') ?? '',
        notes: formData.get('notes') ?? '',
      }),
      audit,
    );
    // A clash with hours already recorded is something to go and look at,
    // not a fault.
    if (!result.ok) return { error: result.message };
    id = result.id;
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/shifts');
  redirect(`/shifts/${id}`);
}
