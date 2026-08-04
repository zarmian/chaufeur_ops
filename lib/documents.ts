import { Prisma, type DocumentType } from '@prisma/client';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { fromDateOnlyString } from './dates';
import { prisma } from './prisma';
import { buildObjectKey, upload } from './storage';
import { emptyToNull } from './text';

/**
 * Compliance documents — the scans behind the expiry dates.
 *
 * The dates on the driver and vehicle records are what drives compliance;
 * these are the evidence. The legacy system had this the other way round:
 * images with no dates, which is why it could never warn about anything.
 */

export const DOCUMENT_TYPES = [
  { value: 'DVLA_LICENCE', label: 'DVLA licence', scope: 'driver' },
  { value: 'PHV_BADGE', label: 'PHV driver badge', scope: 'driver' },
  { value: 'DBS', label: 'DBS check', scope: 'driver' },
  { value: 'PHV_VEHICLE', label: 'PHV vehicle licence', scope: 'vehicle' },
  { value: 'MOT', label: 'MOT certificate', scope: 'vehicle' },
  { value: 'INSURANCE', label: 'Insurance', scope: 'vehicle' },
  { value: 'V5_LOGBOOK', label: 'V5 logbook', scope: 'vehicle' },
  { value: 'OTHER', label: 'Other', scope: 'both' },
] as const;

/**
 * Types whose expiry date is mandatory.
 *
 * These are the ones compliance is judged on. A V5 logbook does not expire
 * and "Other" could be anything, so those stay optional — but nothing that
 * gates a driver getting in a car may be filed without a date.
 */
export const EXPIRY_REQUIRED: DocumentType[] = [
  'DVLA_LICENCE',
  'PHV_BADGE',
  'PHV_VEHICLE',
  'INSURANCE',
  'MOT',
];

export function requiresExpiry(type: DocumentType): boolean {
  return EXPIRY_REQUIRED.includes(type);
}

export function documentLabel(type: DocumentType): string {
  return DOCUMENT_TYPES.find((d) => d.value === type)?.label ?? type;
}

export const documentSchema = z
  .object({
    type: z.enum([
      'DVLA_LICENCE',
      'PHV_BADGE',
      'PHV_VEHICLE',
      'V5_LOGBOOK',
      'INSURANCE',
      'MOT',
      'DBS',
      'OTHER',
    ]),
    issuedOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .or(z.literal('')),
    expiresOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
      .optional()
      .or(z.literal('')),
    /** `replace` supersedes the current document of this type; `keep` files both. */
    mode: z.enum(['replace', 'keep']).default('replace'),
  })
  .refine(
    (value) =>
      !requiresExpiry(value.type) ||
      (value.expiresOn !== undefined && value.expiresOn !== ''),
    {
      path: ['expiresOn'],
      message:
        'This document type needs an expiry date — compliance cannot be judged without one',
    },
  );

export type DocumentInput = z.infer<typeof documentSchema>;

export interface DocumentOwner {
  driverId?: string;
  vehicleId?: string;
}

/**
 * Store a document and, when it carries an expiry, push that date onto the
 * driver or vehicle record.
 *
 * The date lives on the parent because that is what compliance reads on every
 * list render — walking every document per row would be a query per driver.
 * The document remains the evidence for the date.
 */
export async function addDocument(
  owner: DocumentOwner,
  input: DocumentInput,
  file: { buffer: Buffer; fileName: string; mimeType: string },
  context: AuditContext,
): Promise<{ id: string }> {
  const entityType = owner.driverId ? 'driver' : 'vehicle';
  const entityId = owner.driverId ?? owner.vehicleId;
  if (!entityId) throw new Error('A document must belong to a driver or vehicle');

  const key = buildObjectKey(entityType, entityId, file.fileName);
  // Uploaded before the transaction: a failed upload must not leave a row
  // pointing at an object that does not exist.
  await upload(file.buffer, key, file.mimeType);

  const expiresOn =
    input.expiresOn && input.expiresOn !== ''
      ? fromDateOnlyString(input.expiresOn)
      : null;

  return withAudit(
    'Document',
    'create',
    async (tx) => {
      if (input.mode === 'replace') {
        // Supersede rather than delete: the old certificate is the reason a
        // job six months ago was compliant, and that has to stay auditable.
        const previous = await tx.document.findMany({
          where: {
            type: input.type,
            supersededBy: null,
            deletedAt: null,
            ...(owner.driverId
              ? { driverId: owner.driverId }
              : { vehicleId: owner.vehicleId }),
          },
          select: { id: true },
        });
        if (previous.length > 0) {
          await tx.document.updateMany({
            where: { id: { in: previous.map((p) => p.id) } },
            data: { supersededBy: key },
          });
        }
      }

      const created = await tx.document.create({
        data: {
          type: input.type,
          driverId: owner.driverId ?? null,
          vehicleId: owner.vehicleId ?? null,
          fileKey: key,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.buffer.byteLength,
          issuedOn:
            input.issuedOn && input.issuedOn !== ''
              ? fromDateOnlyString(input.issuedOn)
              : null,
          expiresOn,
          uploadedById: context.userId ?? null,
        },
      });

      if (expiresOn) {
        await syncExpiryToParent(tx, owner, input.type, expiresOn);
      }

      return { entityId: created.id, after: created, result: { id: created.id } };
    },
    context,
  );
}

/** Mirror a document's expiry onto the column compliance actually reads. */
async function syncExpiryToParent(
  tx: Prisma.TransactionClient,
  owner: DocumentOwner,
  type: DocumentType,
  expiresOn: Date,
): Promise<void> {
  if (owner.driverId) {
    const field =
      type === 'DVLA_LICENCE'
        ? 'dvlaLicenceExpiry'
        : type === 'PHV_BADGE'
          ? 'phvBadgeExpiry'
          : null;
    if (!field) return;
    await tx.driver.update({
      where: { id: owner.driverId },
      data: { [field]: expiresOn },
    });
    return;
  }

  if (owner.vehicleId) {
    const field =
      type === 'MOT'
        ? 'motExpiry'
        : type === 'INSURANCE'
          ? 'insuranceExpiry'
          : type === 'PHV_VEHICLE'
            ? 'phvLicenceExpiry'
            : null;
    if (!field) return;
    await tx.vehicle.update({
      where: { id: owner.vehicleId },
      data: { [field]: expiresOn },
    });
  }
}

export async function getDocument(id: string) {
  return prisma.document.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      fileKey: true,
      fileName: true,
      mimeType: true,
      driverId: true,
      vehicleId: true,
    },
  });
}

/** Soft delete. ADMIN only — enforced by the caller's capability check. */
export async function deleteDocument(
  id: string,
  context: AuditContext,
): Promise<void> {
  await withAudit(
    'Document',
    'delete',
    async (tx) => {
      const before = await tx.document.findUniqueOrThrow({ where: { id } });
      await tx.document.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      return { entityId: id, before, result: null };
    },
    context,
  );
}

/** Notes to show beside an upload form, so the rules are visible up front. */
export function documentHint(type: DocumentType): string {
  return requiresExpiry(type)
    ? 'An expiry date is required — a document without one counts as non-compliant, never as valid.'
    : 'An expiry date is optional for this type.';
}

export { emptyToNull };
