'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  contractSchema,
  createContract,
  generateContractJobs,
  setContractActive,
  updateContract,
} from '@/lib/contracts';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { getLocaleConfig } from '@/lib/locale-store';
import { actingUser } from '@/lib/request-context';

/**
 * The form's fields, in one place.
 *
 * Shared by create and edit so the two cannot drift — a field wired into only
 * one of them saves on a new contract and silently does nothing on an
 * existing one.
 */
function readContractForm(formData: FormData) {
  return {
    label: formData.get('label') ?? '',
    clientId: formData.get('clientId') ?? '',
    accountId: formData.get('accountId') ?? '',
    pickupText: formData.get('pickupText') ?? '',
    dropoffText: formData.get('dropoffText') ?? '',
    viaText: formData.get('viaText') ?? '',
    pickupPostcode: formData.get('pickupPostcode') ?? '',
    dropoffPostcode: formData.get('dropoffPostcode') ?? '',
    startTime: formData.get('startTime') ?? '',
    estimatedMinutes: formData.get('estimatedMinutes') ?? '',
    passengerName: formData.get('passengerName') ?? '',
    passengerPhone: formData.get('passengerPhone') ?? '',
    driverId: formData.get('driverId') ?? '',
    vehicleId: formData.get('vehicleId') ?? '',
    // An unticked box posts nothing, so an empty list means every day — which
    // is what the form says it means.
    weekdays: formData.getAll('weekdays').map((value) => Number(value)),
    startsOn: formData.get('startsOn') ?? '',
    endsOn: formData.get('endsOn') ?? '',
    dayRatePence: formData.get('dayRate') ?? '',
    driverDayRatePence: formData.get('driverDayRate') ?? '',
    vatTreatment: formData.get('vatTreatment') ?? '',
    generateAheadDays: formData.get('generateAheadDays') ?? '14',
    notes: formData.get('notes') ?? '',
  };
}

export async function createContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editJobs');
    const parsed = contractSchema.parse(readContractForm(formData));
    const created = await createContract(parsed, audit);
    id = created.id;

    // Book the first days now rather than leaving the contract looking empty
    // until the cron runs overnight. An operator who sets one up expects to
    // see it on the board.
    const { timeZone } = await getLocaleConfig();
    await generateContractJobs(id, audit, { timeZone });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/contracts');
  revalidatePath('/jobs');
  redirect(`/contracts/${id}`);
}

export async function updateContractAction(
  contractId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobs');
    const parsed = contractSchema.parse(readContractForm(formData));
    await updateContract(contractId, parsed, audit);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/contracts');
  revalidatePath(`/contracts/${contractId}`);
  redirect(`/contracts/${contractId}`);
}

/**
 * Stop or restart a contract.
 *
 * Stopping makes no more days. The days it already made stay: they are
 * bookings a client is expecting, and each is cancelled individually if it is
 * not going to happen.
 */
export async function setContractActiveAction(
  contractId: string,
  active: boolean,
): Promise<void> {
  const { audit } = await actingUser('editJobs');
  await setContractActive(contractId, active, audit);
  revalidatePath('/contracts');
  revalidatePath(`/contracts/${contractId}`);
}

/** Book the days now, without waiting for the overnight run. */
export async function generateNowAction(contractId: string): Promise<void> {
  const { audit } = await actingUser('editJobs');
  const { timeZone } = await getLocaleConfig();
  await generateContractJobs(contractId, audit, { timeZone });
  revalidatePath('/contracts');
  revalidatePath(`/contracts/${contractId}`);
  revalidatePath('/jobs');
}
