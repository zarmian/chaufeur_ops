import { randomUUID } from 'node:crypto';
import { del, head, issueSignedToken, presignUrl, put } from '@vercel/blob';

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
 */

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
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

function assertAllowed(mimeType: string, sizeBytes: number): void {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new StorageValidationError(
      `${mimeType} is not an accepted file type. Upload a JPEG, PNG, WebP or PDF.`,
    );
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1);
    throw new StorageValidationError(
      `That file is ${mb} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (sizeBytes <= 0) {
    throw new StorageValidationError('That file is empty.');
  }
}

/**
 * Strip anything that could confuse a path or a Content-Disposition header.
 * The original name is kept in the database for display; this is only the
 * tail of the object key.
 */
export function sanitiseFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned || 'file';
}

/**
 * `documents/driver/clx123/9f8e-phv-badge.pdf`
 *
 * Namespaced by entity so an object's owner is obvious from the key alone,
 * which matters when auditing or cleaning up orphans. The UUID makes the key
 * unguessable and lets the same filename be uploaded twice.
 */
export function buildObjectKey(
  entityType: string,
  entityId: string,
  fileName: string,
  prefix = 'documents',
): string {
  return `${prefix}/${entityType}/${entityId}/${randomUUID()}-${sanitiseFileName(fileName)}`;
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
