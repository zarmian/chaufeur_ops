'use server';

import { revalidatePath } from 'next/cache';
import {
  deleteDocument,
  documentSchema,
  recordDocument,
} from '@/lib/documents';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';
import {
  describeUploadRefusal,
  isStorageConfigured,
  keyBelongsTo,
  statObject,
  type DocumentEntityType,
} from '@/lib/storage';

/**
 * Record a document the browser has already uploaded.
 *
 * The file does not come through here. It goes from the browser straight to
 * Blob storage against a token issued by `app/api/documents/upload/route.ts`,
 * because a Server Action's body is capped at 1 MB by default and a Vercel
 * Function's at 4.5 MB — either of which a scanned MOT certificate exceeds.
 * That was the bug: uploads under a megabyte worked, anything larger died in
 * the framework with the generic error boundary and no reason on it.
 *
 * What arrives here is a key and some form fields, which is small. The one
 * thing this must not do is believe them:
 *
 *   - the key is re-checked against the record being uploaded to, so a
 *     tampered form cannot attach another entity's object to this one;
 *   - the size and content type are read back **from storage** with `head()`,
 *     never taken from the request, so the row cannot claim a 200 KB PDF that
 *     is really a 2 GB something-else;
 *   - `head()` failing means the object is not there, which is the honest
 *     answer when an upload was abandoned halfway.
 */
export async function recordDocumentAction(
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

    const key = String(formData.get('fileKey') ?? '');
    const fileName = String(formData.get('fileName') ?? '');
    if (key === '' || fileName === '') {
      return { error: 'That upload did not finish. Try again.' };
    }

    const entityType: DocumentEntityType = owner.driverId ? 'driver' : 'vehicle';
    const entityId = owner.driverId ?? owner.vehicleId;
    if (!entityId) return { error: 'That document has no owner' };

    if (!keyBelongsTo(key, entityType, entityId)) {
      return { error: 'That file does not belong to this record' };
    }

    const input = documentSchema.parse({
      type: formData.get('type') ?? 'OTHER',
      issuedOn: formData.get('issuedOn') ?? '',
      expiresOn: formData.get('expiresOn') ?? '',
      mode: formData.get('mode') ?? 'replace',
    });

    // The object's own account of itself, which is the only one worth having.
    const stored = await statObject(key);
    if (!stored) {
      return {
        error: 'That upload did not reach storage. Try again.',
      };
    }

    const refusal = describeUploadRefusal({
      type: stored.contentType,
      size: stored.size,
    });
    if (refusal) return { error: refusal };

    await recordDocument(
      owner,
      input,
      {
        key,
        // The name as typed by whoever named the file, for display. The key
        // carries the sanitised version.
        fileName,
        mimeType: stored.contentType,
        sizeBytes: stored.size,
      },
      audit,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error, 'That document could not be recorded');
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
