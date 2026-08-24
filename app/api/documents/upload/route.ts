import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  entityIdOf,
  entityTypeOf,
  isStorageConfigured,
  keyBelongsTo,
  parseUploadOwner,
  type DocumentEntityType,
} from '@/lib/storage';

/**
 * `POST /api/documents/upload` — a token for one browser-to-Blob upload.
 *
 * Documents do not pass through the server any more. They used to, through a
 * Server Action, and that quietly capped every upload at Next's 1 MB default
 * body limit: a scanned MOT certificate or a phone photo of an insurance
 * certificate — three to five megabytes, routinely — was rejected by the
 * framework before a line of application code ran, so the operator got the
 * error boundary with no reason on it. Raising the limit could not have
 * fixed it either: a Vercel Function refuses a request body over 4.5 MB, and
 * the form promises 10.
 *
 * So the file goes from the browser straight to Blob storage, and this route
 * issues the short-lived token that permits exactly that one write.
 *
 * **The browser names the pathname it wants.** That is how the SDK works —
 * the token is scoped to a pathname the client proposes — so everything below
 * exists to make sure the pathname is one this user is allowed to write:
 *
 *   1. the caller holds `editDocuments`;
 *   2. the key is under `documents/`, is well-formed, and its entity segment
 *      matches the driver or vehicle named in the client payload;
 *   3. that driver or vehicle actually exists and is not soft-deleted;
 *   4. the token itself caps the content type and the size, so the
 *      constraints are enforced by the storage service and not merely by the
 *      browser that asked.
 *
 * Without (2) an operator with a debugger could have this route sign a write
 * into any other record's folder. `keyBelongsTo` is tested for exactly that.
 *
 * `onUploadCompleted` is deliberately not used. It is a callback from Vercel
 * to the deployment, which never fires against `localhost`, so a database row
 * created there would exist in production and not in development. The row is
 * written afterwards by `recordDocumentAction`, which re-reads the object's
 * real size and type with `head()` rather than believing the browser.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ten minutes. Long enough for a slow phone on a bad connection, no longer. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** That the owner exists and has not been deleted. */
async function ownerExists(
  entityType: DocumentEntityType,
  entityId: string,
): Promise<boolean> {
  if (entityType === 'driver') {
    return (
      (await prisma.driver.findFirst({ where: { id: entityId }, select: { id: true } })) !==
      null
    );
  }
  return (
    (await prisma.vehicle.findFirst({ where: { id: entityId }, select: { id: true } })) !==
    null
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!isStorageConfigured()) {
    return apiError(
      'VALIDATION_FAILED',
      'File storage is not configured. Create a Vercel Blob store and redeploy.',
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return apiError('VALIDATION_FAILED', 'That request could not be read');
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Inside the callback, so an unauthenticated caller never learns
        // whether the pathname they guessed was a real one.
        await requireCapability('editDocuments');

        const owner = parseUploadOwner(clientPayload);
        if (!owner) {
          throw new Error('An upload must name the driver or vehicle it belongs to');
        }

        const entityType = entityTypeOf(owner);
        const entityId = entityIdOf(owner);

        if (!keyBelongsTo(pathname, entityType, entityId)) {
          throw new Error('That upload path does not belong to this record');
        }

        if (!(await ownerExists(entityType, entityId))) {
          throw new Error('That record no longer exists');
        }

        return {
          // Enforced by the storage service, so neither the browser's own
          // check nor its honesty is what holds the line.
          allowedContentTypes: [...ALLOWED_MIME_TYPES],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          validUntil: Date.now() + TOKEN_TTL_MS,
          // The key already carries a UUID, so a second suffix would only make
          // the stored pathname differ from the one the row records.
          addRandomSuffix: false,
          // Keys are unique by construction; overwriting would mean a bug —
          // or somebody replacing a document that is evidence for a past job.
          allowOverwrite: false,
        };
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    /*
     * 400 rather than 500: everything thrown above is a refusal, and the SDK
     * turns whatever comes back into the message the operator sees. The text
     * is our own, so it says what to do rather than naming an internal.
     */
    return NextResponse.json(
      {
        error: {
          code: 'UPLOAD_REFUSED',
          message:
            error instanceof Error ? error.message : 'That upload could not be authorised',
        },
      },
      { status: 400 },
    );
  }
}
