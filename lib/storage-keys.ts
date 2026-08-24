/**
 * What an object is called, and what may be uploaded — with no imports.
 *
 * Split out of `lib/storage.ts` so both ends of an upload can share it. Since
 * documents go **straight from the browser to Blob storage**, the key is built
 * in the browser and validated on the server, and the two have to agree
 * exactly: the server issues a token scoped to the pathname the browser asked
 * for, and a pathname it cannot parse is one it cannot authorise.
 *
 * Nothing here may import `node:crypto`, `@vercel/blob` or Prisma —
 * `lib/client-bundle.test.ts` walks the import graph out of every Client
 * Component and fails the build if it reaches server-only code. That is why
 * `buildObjectKey` is handed a UUID rather than making one: the browser has
 * `crypto.randomUUID()` and the server has `node:crypto`, and this module
 * needs to know about neither.
 */

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * Branding assets accept SVG on top of the document types, because a logo
 * that has to stay crisp on a PDF letterhead is usually vector.
 *
 * An SVG is a document that can carry script, so it is never inlined into a
 * page. Branding assets are served from the Blob store's own origin behind a
 * signed URL and rendered in an `<img>`, where script inside the file does
 * not execute.
 */
export const BRAND_MIME_TYPES = [
  ...ALLOWED_MIME_TYPES,
  'image/svg+xml',
] as const;

/**
 * 10 MB, and it is now a real limit rather than an aspiration.
 *
 * It used to be neither. Uploads went through a Server Action, and Next caps
 * a Server Action's body at 1 MB unless told otherwise — so every file over
 * about a megabyte was rejected by the framework before any of this code ran,
 * and the operator got the generic error boundary rather than a reason. A
 * scanned MOT certificate is routinely three or four times that.
 *
 * Vercel Functions also refuse a request body over 4.5 MB, so raising the
 * Server Action limit could never have reached 10 MB either. Uploading
 * straight from the browser to Blob storage sidesteps both, and this number
 * is enforced three times over: in the browser before the upload starts, in
 * the token the server issues, and against the stored object's real size when
 * the row is written.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Where document objects live. Anything else is not a document. */
export const DOCUMENT_PREFIX = 'documents';

export type DocumentEntityType = 'driver' | 'vehicle';

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
 * `documents/vehicle/clx123/9f8e…-mot.pdf`
 *
 * Namespaced by entity so an object's owner is obvious from the key alone,
 * which matters when auditing or cleaning up orphans — and, now that the
 * browser proposes the key, is what the server checks before it will sign
 * anything. The UUID makes the key unguessable and lets the same filename be
 * uploaded twice.
 */
export function buildObjectKey(
  entityType: string,
  entityId: string,
  uuid: string,
  fileName: string,
  prefix: string = DOCUMENT_PREFIX,
): string {
  return `${prefix}/${entityType}/${entityId}/${uuid}-${sanitiseFileName(fileName)}`;
}

export interface ParsedObjectKey {
  prefix: string;
  entityType: string;
  entityId: string;
  fileName: string;
}

/**
 * Read a key back apart, or null if it is not one of ours.
 *
 * The server's half of the bargain. A browser asking for a token names the
 * pathname it wants to write, so this is what stands between "upload my MOT"
 * and "upload into somebody else's namespace, or out of `documents/`
 * altogether". Deliberately strict: exactly four segments, no traversal, no
 * empty parts.
 */
export function parseObjectKey(key: string): ParsedObjectKey | null {
  if (typeof key !== 'string' || key === '') return null;
  // No traversal, no absolute paths, no backslashes pretending to be
  // separators on a platform that would accept them.
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) return null;

  const parts = key.split('/');
  if (parts.length !== 4) return null;

  const [prefix, entityType, entityId, fileName] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!prefix || !entityType || !entityId || !fileName) return null;

  return { prefix, entityType, entityId, fileName };
}

/**
 * Whether a key belongs to this entity, for the token route.
 *
 * Returns a boolean rather than throwing because both callers want to answer
 * a refusal with a message rather than a stack trace.
 */
export function keyBelongsTo(
  key: string,
  entityType: DocumentEntityType,
  entityId: string,
): boolean {
  const parsed = parseObjectKey(key);
  return (
    parsed !== null &&
    parsed.prefix === DOCUMENT_PREFIX &&
    parsed.entityType === entityType &&
    parsed.entityId === entityId
  );
}

/**
 * Why a file cannot be uploaded, or null if it can.
 *
 * One function so the browser and the server refuse in the same words. The
 * browser's copy is the one an operator reads — it fires the moment they pick
 * the file, before anything is sent — and the server's is the one that counts.
 */
export function describeUploadRefusal(
  file: { type: string; size: number },
  allowed: readonly string[] = ALLOWED_MIME_TYPES,
): string | null {
  if (!allowed.includes(file.type)) {
    const list =
      allowed === ALLOWED_MIME_TYPES
        ? 'JPEG, PNG, WebP or PDF'
        : 'JPEG, PNG, WebP, SVG or PDF';
    return `${file.type || 'That file type'} is not an accepted file type. Upload a ${list}.`;
  }
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `That file is ${mb} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

export interface UploadOwner {
  driverId?: string;
  vehicleId?: string;
}

/**
 * The owner a browser claims an upload is for, or null.
 *
 * Parsed here rather than in the route so it can be tested: it is the input
 * the token route trusts least, and it carries one rule that is easy to write
 * and easy to get wrong — **exactly one owner**. Neither would leave nothing
 * to check the pathname against; both would make "which namespace is this
 * for?" ambiguous at the single point where ambiguity is the vulnerability.
 */
export function parseUploadOwner(raw: string | null | undefined): UploadOwner | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const { driverId, vehicleId } = parsed as UploadOwner;
  if (driverId !== undefined && typeof driverId !== 'string') return null;
  if (vehicleId !== undefined && typeof vehicleId !== 'string') return null;
  if (Boolean(driverId) === Boolean(vehicleId)) return null;

  return driverId ? { driverId } : { vehicleId };
}

/** Which namespace an owner's documents live under. */
export function entityTypeOf(owner: UploadOwner): DocumentEntityType {
  return owner.driverId ? 'driver' : 'vehicle';
}

/** The id, whichever kind it is. */
export function entityIdOf(owner: UploadOwner): string {
  return (owner.driverId ?? owner.vehicleId) as string;
}
