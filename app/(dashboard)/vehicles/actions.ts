'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';
import {
  archiveVehicle,
  createVehicle,
  updateVehicle,
  vehicleSchema,
} from '@/lib/vehicles';

function readForm(formData: FormData) {
  return {
    registration: formData.get('registration') ?? '',
    make: formData.get('make') ?? '',
    model: formData.get('model') ?? '',
    variant: formData.get('variant') ?? '',
    vehicleClass: formData.get('vehicleClass') ?? 'EXECUTIVE',
    colour: formData.get('colour') ?? '',
    seats: formData.get('seats') ?? 4,
    phvLicenceNumber: formData.get('phvLicenceNumber') ?? '',
    phvLicenceExpiry: formData.get('phvLicenceExpiry') ?? '',
    motExpiry: formData.get('motExpiry') ?? '',
    insuranceExpiry: formData.get('insuranceExpiry') ?? '',
    insurancePolicyNo: formData.get('insurancePolicyNo') ?? '',
    status: formData.get('status') ?? 'ACTIVE',
  };
}

export async function createVehicleAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editVehicles');
    ({ id } = await createVehicle(vehicleSchema.parse(readForm(formData)), audit));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/vehicles');
  redirect(`/vehicles/${id}`);
}

export async function updateVehicleAction(
  vehicleId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editVehicles');
    await updateVehicle(vehicleId, vehicleSchema.parse(readForm(formData)), audit);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/vehicles');
  revalidatePath(`/vehicles/${vehicleId}`);
  redirect(`/vehicles/${vehicleId}`);
}

export async function archiveVehicleAction(
  vehicleId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('deleteRecords');
    const result = await archiveVehicle(vehicleId, audit);
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/vehicles');
  redirect('/vehicles');
}
