import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

/**
 * File storage on Cloudflare R2, S3-compatible.
 *
 * Binaries never go in Postgres — the database holds the object key and
 * nothing else. The bucket is private: every read is a short-lived signed
 * URL, so a leaked link to someone's DVLA licence expires in minutes rather
 * than being public forever.
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
      'File storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
    );
    this.name = 'StorageNotConfiguredError';
  }
}

interface StorageConfig {
  bucket: string;
  client: S3Client;
}

let cached: StorageConfig | null = null;

/** True when the environment carries enough to talk to R2. */
export function isStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

function storage(): StorageConfig {
  if (cached) return cached;
  if (!isStorageConfigured()) throw new StorageNotConfiguredError();

  const accountId = process.env.R2_ACCOUNT_ID!;
  const endpoint =
    process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

  cached = {
    bucket: process.env.R2_BUCKET!,
    client: new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    }),
  };
  return cached;
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
 * which matters when auditing or cleaning up orphans.
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
  assertAllowed(mimeType, buffer.byteLength);

  const { client, bucket } = storage();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return { key, sizeBytes: buffer.byteLength };
}

/** A time-limited read URL. Defaults to 15 minutes. */
export async function getSignedUrl(
  key: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const { client, bucket } = storage();
  return presign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttlSeconds,
  });
}

/**
 * Remove an object. Note this *is* a hard delete — the soft-delete rule
 * applies to database records, and the `Document` row survives. Only call
 * this when purging, never as part of the normal delete path.
 */
export async function remove(key: string): Promise<void> {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function exists(key: string): Promise<boolean> {
  const { client, bucket } = storage();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Validate an uploaded `File` before it reaches R2. */
export function assertUploadable(file: File): void {
  assertAllowed(file.type, file.size);
}
