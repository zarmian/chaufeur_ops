'use server';

import { revalidatePath } from 'next/cache';
import {
  addDocument,
  deleteDocument,
  documentSchema,
} from '@/lib/documents';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';
import { assertUploadable, isStorageConfigured } from '@/lib/storage';

/**
 * Upload a compliance document against a driver or vehicle.
 *
 * Validation happens before anything is stored, and the size and type limits
 * are checked here as well as inside `lib/storage.ts` — the second check is
 * the one that counts, this one just fails faster and says so nicely.
 */
export async function uploadDocumentAction(
  owner: { driverId?: string; vehicleId?: string },
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editDocuments');

    if (!isStorageConfigured()) {
      return {
        error:
          'File storage is not configured yet. Create a Vercel Blob store and redeploy — the expiry dates on the record still work without it.',
      };
    }

    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return { error: 'Choose a file to upload' };
    }

    try {
      assertUploadable(file);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid file' };
    }

    const input = documentSchema.parse({
      type: formData.get('type') ?? 'OTHER',
      issuedOn: formData.get('issuedOn') ?? '',
      expiresOn: formData.get('expiresOn') ?? '',
      mode: formData.get('mode') ?? 'replace',
    });

    await addDocument(
      owner,
      input,
      {
        buffer: Buffer.from(await file.arrayBuffer()),
        fileName: file.name,
        mimeType: file.type,
      },
      audit,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error, 'That document could not be uploaded');
  }

  const path = owner.driverId
    ? `/drivers/${owner.driverId}`
    : `/vehicles/${owner.vehicleId}`;
  revalidatePath(path);
  revalidatePath('/compliance');

  return { error: null };
}

/** Soft delete. ADMIN only. */
export async function deleteDocumentAction(
  documentId: string,
  returnPath: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('deleteRecords');
    await deleteDocument(documentId, audit);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath(returnPath);
  return { error: null };
}
