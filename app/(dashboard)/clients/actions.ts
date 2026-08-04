'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import {
  archiveClient,
  clientSchema,
  createClient,
  restoreClient,
  updateClient,
} from '@/lib/clients';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { actingUser } from '@/lib/request-context';
import { zodFields } from '@/lib/api';
import type { ArchiveState, ClientFormState } from './form-state';

function readForm(formData: FormData) {
  return {
    name: formData.get('name') ?? '',
    contactPhone: formData.get('contactPhone') ?? '',
    contactEmail: formData.get('contactEmail') ?? '',
    billingEmail: formData.get('billingEmail') ?? '',
    billingAddress: formData.get('billingAddress') ?? '',
    vatNumber: formData.get('vatNumber') ?? '',
    paymentTermsDays: formData.get('paymentTermsDays') ?? 14,
    defaultAccountId: formData.get('defaultAccountId') ?? '',
    notes: formData.get('notes') ?? '',
  };
}

function toState(error: unknown): ClientFormState {
  if (error instanceof ZodError) {
    return { error: 'Check the highlighted fields', fields: zodFields(error) };
  }
  if (error instanceof UnauthenticatedError) redirect('/login');
  if (error instanceof ForbiddenError) return { error: error.message };
  throw error;
}

export async function createClientAction(
  _previous: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editClients');
    const input = clientSchema.parse(readForm(formData));
    ({ id } = await createClient(input, audit));
  } catch (error) {
    return toState(error);
  }

  revalidatePath('/clients');
  redirect(`/clients/${id}`);
}

export async function updateClientAction(
  clientId: string,
  _previous: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  try {
    const { audit } = await actingUser('editClients');
    const input = clientSchema.parse(readForm(formData));
    await updateClient(clientId, input, audit);
  } catch (error) {
    return toState(error);
  }

  revalidatePath('/clients');
  revalidatePath(`/clients/${clientId}`);
  redirect(`/clients/${clientId}`);
}

export async function archiveClientAction(
  clientId: string,
  _previous: ArchiveState,
  _formData: FormData,
): Promise<ArchiveState> {
  try {
    // Archiving is a delete, and deletes are ADMIN-only.
    const { audit } = await actingUser('deleteRecords');
    const result = await archiveClient(clientId, audit);
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect('/login');
    if (error instanceof ForbiddenError) return { error: error.message };
    throw error;
  }

  revalidatePath('/clients');
  redirect('/clients');
}

export async function restoreClientAction(
  clientId: string,
  _previous: ArchiveState,
  _formData: FormData,
): Promise<ArchiveState> {
  try {
    const { audit } = await actingUser('deleteRecords');
    await restoreClient(clientId, audit);
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect('/login');
    if (error instanceof ForbiddenError) return { error: error.message };
    throw error;
  }

  revalidatePath('/clients');
  redirect(`/clients/${clientId}`);
}
