'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  accountSchema,
  archiveAccount,
  createAccount,
  updateAccount,
} from '@/lib/accounts';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';

function readForm(formData: FormData) {
  return {
    name: formData.get('name') ?? '',
    kind: formData.get('kind') ?? 'CORPORATE',
    contactName: formData.get('contactName') ?? '',
    contactPhone: formData.get('contactPhone') ?? '',
    contactEmail: formData.get('contactEmail') ?? '',
    billingEmail: formData.get('billingEmail') ?? '',
    billingAddress: formData.get('billingAddress') ?? '',
    vatNumber: formData.get('vatNumber') ?? '',
    paymentTermsDays: formData.get('paymentTermsDays') ?? 14,
    commissionPct: formData.get('commissionPct') ?? '',
    active: formData.get('active') === 'on',
  };
}

export async function createAccountAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editClients');
    ({ id } = await createAccount(accountSchema.parse(readForm(formData)), audit));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/accounts');
  redirect(`/accounts/${id}`);
}

export async function updateAccountAction(
  accountId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editClients');
    await updateAccount(accountId, accountSchema.parse(readForm(formData)), audit);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/accounts');
  revalidatePath(`/accounts/${accountId}`);
  redirect(`/accounts/${accountId}`);
}

export async function archiveAccountAction(
  accountId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('deleteRecords');
    const result = await archiveAccount(accountId, audit);
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/accounts');
  redirect('/accounts');
}
