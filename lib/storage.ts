import { randomUUID } from 'node:crypto';
import { del, head, issueSignedToken, presignUrl, put } from '@vercel/blob';
import {
  ALLOWED_MIME_TYPES,
  BRAND_MIME_TYPES,
  DOCUMENT_PREFIX,
  buildObjectKey as buildKey,
  describeUploadRefusal,
} from './storage-keys';

/**
 * File storage on Vercel Blob, private.
 *
 * These are DVLA licences and PHV badges — identity documents for every
 * driver on the fleet — so `access: 'private'` is not optional. A private
 * blob is unreachable without a signed URL, and every signed URL here is
 * scoped to one pathname, one operation and a short expiry. Nothing is ever
 * uploaded with public access.
 *
 * Binaries never go in Postgres. The database holds the pathname and nothing
 * else, which is what makes a document's owner obvious from its key alone.
 *
 * Document uploads no longer pass through here on their way in — they go
 * from the browser straight to Blob storage, because a Server Action's body
 * is capped well below what a scanned certificate weighs. See
 * `app/api/documents/upload/route.ts`. What remains server-side is issuing
 * the read URLs, deleting, and the branding assets, which are small.
 *
 * The names, limits and key format live in `./storage-keys`, with no imports,
 * so the browser half of an upload can share them.
 */

export {
  ALLOWED_MIME_TYPES,
  BRAND_MIME_TYPES,
  DOCUMENT_PREFIX,
  MAX_UPLOAD_BYTES,
  describeUploadRefusal,
  entityIdOf,
  entityTypeOf,
  keyBelongsTo,
  parseObjectKey,
  parseUploadOwner,
  sanitiseFileName,
} from './storage-keys';
export type {
  AllowedMimeType,
  DocumentEntityType,
  UploadOwner,
} from './storage-keys';

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageValidationError';
  }
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      'File storage is not configured. Create a Vercel Blob store and set BLOB_READ_WRITE_TOKEN.',
    );
    this.name = 'StorageNotConfiguredError';
  }
}

/**
 * True when the environment can reach a Blob store.
 *
 * On Vercel the token is injected by the Blob integration. Locally it has to
 * be pulled down with `vercel env pull`.
 */
export function isStorageConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function assertConfigured(): void {
  if (!isStorageConfigured()) throw new StorageNotConfiguredError();
}

function assertAllowed(
  mimeType: string,
  sizeBytes: number,
  allowed: readonly string[] = ALLOWED_MIME_TYPES,
): void {
  // One wording for every refusal, wherever it happens — the browser says the
  // same thing before the upload starts.
  const refusal = describeUploadRefusal({ type: mimeType, size: sizeBytes }, allowed);
  if (refusal) throw new StorageValidationError(refusal);
}

/**
 * A key for a new object, with a fresh UUID.
 *
 * The server-side convenience wrapper. The browser calls the shared builder
 * directly with `crypto.randomUUID()`.
 */
export function buildObjectKey(
  entityType: string,
  entityId: string,
  fileName: string,
  prefix: string = DOCUMENT_PREFIX,
): string {
  return buildKey(entityType, entityId, randomUUID(), fileName, prefix);
}

export async function upload(
  buffer: Buffer | Uint8Array,
  key: string,
  mimeType: string,
): Promise<{ key: string; sizeBytes: number }> {
  // Validated before the network call, so a rejected file costs nothing.
  assertAllowed(mimeType, buffer.byteLength);
  assertConfigured();

  // The SDK takes a Buffer, a Blob or a stream; a bare Uint8Array is not one
  // of them, and wrapping is a view rather than a copy.
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  await put(key, body, {
    access: 'private',
    contentType: mimeType,
    // The key already carries a UUID, so a second suffix would only make the
    // stored pathname differ from the one recorded in Postgres.
    addRandomSuffix: false,
    // Keys are unique by construction; overwriting would mean a bug upstream.
    allowOverwrite: false,
  });

  return { key, sizeBytes: buffer.byteLength };
}

/**
 * A time-limited read URL for one object. Defaults to 15 minutes.
 *
 * Two steps by design: a delegation token scoped to this pathname and to
 * `get` alone, then a URL signed against it. The long-lived read-write token
 * never leaves the server, and a leaked link grants nothing but this one file
 * until it expires.
 */
export async function getSignedUrl(
  key: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  assertConfigured();

  const validUntil = Date.now() + ttlSeconds * 1000;

  const signedToken = await issueSignedToken({
    pathname: key,
    operations: ['get'],
    validUntil,
  });

  const { presignedUrl } = await presignUrl(signedToken, {
    access: 'private',
    operation: 'get',
    pathname: key,
    validUntil,
  });

  return presignedUrl;
}

/**
 * Remove an object.
 *
 * Note this *is* a hard delete — the soft-delete rule applies to database
 * records, and the `Document` row survives. Only call it when purging, never
 * as part of the normal delete path.
 */
export async function remove(key: string): Promise<void> {
  assertConfigured();
  await del(key);
}

/**
 * What storage says an object actually is.
 *
 * The counterpart to uploading from the browser. When the row is written, the
 * only trustworthy account of a file's size and type is the store's own — the
 * form that reports them has been through a machine we do not control. Null
 * when the object is not there, which is what an abandoned upload looks like.
 */
export async function statObject(
  key: string,
): Promise<{ size: number; contentType: string } | null> {
  assertConfigured();
  try {
    const details = await head(key);
    return {
      size: details.size,
      // Blob returns the type it was told at upload; the token restricted that
      // to the allowlist, and the caller checks it again anyway.
      contentType: details.contentType ?? '',
    };
  } catch {
    return null;
  }
}

export async function exists(key: string): Promise<boolean> {
  assertConfigured();
  try {
    await head(key);
    return true;
  } catch {
    return false;
  }
}

/** Validate an uploaded `File` before it reaches storage. */
export function assertUploadable(file: File): void {
  assertAllowed(file.type, file.size);
}

/** As `assertUploadable`, for the branding assets that may also be SVG. */
export function assertBrandAssetUploadable(file: File): void {
  assertAllowed(file.type, file.size, BRAND_MIME_TYPES);
}

/**
 * Store a branding asset.
 *
 * Separate from `upload` only so the wider allowlist cannot leak into the
 * document path, where an SVG has no business being.
 */
export async function uploadBrandAsset(
  buffer: Buffer | Uint8Array,
  key: string,
  mimeType: string,
): Promise<{ key: string; sizeBytes: number }> {
  assertAllowed(mimeType, buffer.byteLength, BRAND_MIME_TYPES);
  assertConfigured();

  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await put(key, body, {
    access: 'private',
    contentType: mimeType,
    addRandomSuffix: false,
    allowOverwrite: false,
  });

  return { key, sizeBytes: buffer.byteLength };
}
