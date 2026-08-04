'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  archiveDriver,
  createDriver,
  driverSchema,
  updateDriver,
} from '@/lib/drivers';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';

function readForm(formData: FormData) {
  return {
    name: formData.get('name') ?? '',
    phone: formData.get('phone') ?? '',
    email: formData.get('email') ?? '',
    address: formData.get('address') ?? '',
    dvlaLicenceNumber: formData.get('dvlaLicenceNumber') ?? '',
    dvlaLicenceExpiry: formData.get('dvlaLicenceExpiry') ?? '',
    phvBadgeNumber: formData.get('phvBadgeNumber') ?? '',
    phvBadgeExpiry: formData.get('phvBadgeExpiry') ?? '',
    phvIssuingAuthority: formData.get('phvIssuingAuthority') ?? '',
    assignedVehicleId: formData.get('assignedVehicleId') ?? '',
    status: formData.get('status') ?? 'ACTIVE',
    notes: formData.get('notes') ?? '',
  };
}

export async function createDriverAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editDrivers');
    ({ id } = await createDriver(driverSchema.parse(readForm(formData)), audit));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/drivers');
  redirect(`/drivers/${id}`);
}

export async function updateDriverAction(
  driverId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editDrivers');
    await updateDriver(driverId, driverSchema.parse(readForm(formData)), audit);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/drivers');
  revalidatePath(`/drivers/${driverId}`);
  redirect(`/drivers/${driverId}`);
}

export async function archiveDriverAction(
  driverId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('deleteRecords');
    const result = await archiveDriver(driverId, audit);
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/drivers');
  redirect('/drivers');
}
