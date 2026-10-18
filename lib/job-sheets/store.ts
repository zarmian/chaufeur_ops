import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { buildObjectKey, upload } from '../storage';
import type { FieldAlias } from './fields';
import { lessonFrom, stillTrusted } from './learn';
import { PdfTextError, pdfToText } from './pdf';
import { readJobSheet } from './read';
import type {
  FieldSource,
  JobSheetDraft,
  Placement,
  ReadableField,
  SheetRead,
} from './types';

/**
 * Storing a job sheet, and remembering what each sender's paperwork looks like.
 *
 * The database half of `lib/job-sheets`. Everything that decides *what* a sheet
 * says is pure and lives in the other modules; this only persists it, and holds
 * the two pieces of knowledge that have to survive a deployment: which agency a
 * sheet came from, and which labels that agency prints.
 *
 * Neither is code, deliberately. There is a second customer already, and each
 * install meets its own agencies — shipping a template per supplier would mean
 * a release every time somebody wins an account, on two deployments.
 */

/** Where sheet objects live. Separate from `documents/`, which means compliance. */
const SHEET_PREFIX = 'job-sheets';

const PLACEMENT_TO_DB: Record<Placement, 'AFTER' | 'BELOW' | 'COLUMN' | 'PARAGRAPH'> = {
  after: 'AFTER',
  below: 'BELOW',
  column: 'COLUMN',
  paragraph: 'PARAGRAPH',
};

const PLACEMENT_FROM_DB: Record<string, Placement> = {
  AFTER: 'after',
  BELOW: 'below',
  COLUMN: 'column',
  PARAGRAPH: 'paragraph',
};

export interface SheetSenderSummary {
  id: string;
  name: string;
  accountId: string | null;
  clientId: string | null;
}

/**
 * Which sender's sheet this is.
 *
 * Matched on a distinctive string — normally their trading name, which appears
 * in the letterhead and again in the footer. The longest fingerprint wins, so
 * that an agency and a subsidiary sharing most of a name resolve to the more
 * specific one rather than to whichever row happened to be created first.
 *
 * Recognising the wrong sender bills the wrong company, which is why this is a
 * plain containment test against text somebody deliberately entered, and never
 * a guess at a likeliest match.
 */
export async function identifySender(
  text: string,
): Promise<SheetSenderSummary | null> {
  const senders = await prisma.sheetSender.findMany({
    select: { id: true, name: true, fingerprint: true, accountId: true, clientId: true },
  });

  const haystack = text.toLowerCase();
  const matches = senders
    .filter((sender) => haystack.includes(sender.fingerprint))
    .sort((left, right) => right.fingerprint.length - left.fingerprint.length);

  const best = matches[0];
  if (!best) return null;

  return {
    id: best.id,
    name: best.name,
    accountId: best.accountId,
    clientId: best.clientId,
  };
}

/**
 * The labels learned from this sender, best first.
 *
 * Ordered by how often each has been kept rather than changed, so that where
 * two labels could both answer, the one with the better record is tried first.
 * A label being changed more often than it is kept is left out entirely — see
 * `stillTrusted`.
 */
export async function learnedAliases(
  senderId: string,
): Promise<Partial<Record<ReadableField, FieldAlias[]>>> {
  const rows = await prisma.sheetLabel.findMany({
    where: { senderId },
    orderBy: [{ confirmed: 'desc' }, { createdAt: 'asc' }],
  });

  const out: Partial<Record<ReadableField, FieldAlias[]>> = {};

  for (const row of rows) {
    if (!stillTrusted(row)) continue;

    const placement = PLACEMENT_FROM_DB[row.placement];
    if (!placement) continue;

    const field = row.field as ReadableField;
    const aliases = (out[field] ??= []);
    aliases.push({
      label: row.label,
      placement,
      // Short labels are only safe where a field would be printed. Stored
      // labels keep the same rule as the built-in ones.
      ...(row.label.length <= 4 ? { lineStart: true } : {}),
    });
  }

  return out;
}

export interface StoredSheet {
  id: string;
  read: SheetRead;
  sender: SheetSenderSummary | null;
  /**
   * The sheet this one is a byte-for-byte copy of, if it has been seen.
   *
   * Agencies resend sheets — an amended pickup, a chased confirmation, a copy
   * forwarded by somebody else — and booking the same journey twice sends two
   * cars to the same address. The upload says so and offers the job it already
   * made rather than quietly reading it again.
   */
  duplicateOf: { id: string; jobId: string | null } | null;
}

export interface UploadedSheet {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  uploadedById: string | null;
}

/**
 * Read an uploaded sheet and keep everything about it.
 *
 * The order matters. The text is extracted before anything is stored, so a file
 * that cannot be read leaves nothing behind — no orphaned blob, no row claiming
 * to be a sheet. The duplicate check comes before the upload for the same
 * reason.
 */
export async function storeSheet(file: UploadedSheet): Promise<StoredSheet> {
  if (file.mimeType !== 'application/pdf') {
    throw new PdfTextError('Only PDF job sheets can be read.');
  }

  const text = await pdfToText(file.bytes);
  const contentHash = createHash('sha256').update(file.bytes).digest('hex');

  const seen = await prisma.jobSheet.findFirst({
    where: { contentHash },
    select: { id: true, jobId: true },
    orderBy: { uploadedAt: 'desc' },
  });

  const sender = await identifySender(text);
  const learned = sender ? await learnedAliases(sender.id) : {};
  const read = readJobSheet(text, { learned });

  const id = crypto.randomUUID();
  const key = buildObjectKey('sheet', id, file.fileName, SHEET_PREFIX);
  const stored = await upload(file.bytes, key, file.mimeType);

  const row = await prisma.jobSheet.create({
    data: {
      fileKey: stored.key,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: stored.sizeBytes,
      contentHash,
      senderId: sender?.id ?? null,
      text,
      draft: read.draft as unknown as Prisma.InputJsonValue,
      sources: read.sources as unknown as Prisma.InputJsonValue,
      uploadedById: file.uploadedById,
    },
    select: { id: true },
  });

  return { id: row.id, read, sender, duplicateOf: seen };
}

export interface SheetForForm {
  id: string;
  fileName: string;
  draft: JobSheetDraft;
  sources: Partial<Record<ReadableField, FieldSource>>;
  missing: string[];
  sender: SheetSenderSummary | null;
  jobId: string | null;
}

/** A stored sheet, for pre-filling the booking form. */
export async function getSheet(id: string): Promise<SheetForForm | null> {
  const row = await prisma.jobSheet.findUnique({
    where: { id },
    include: {
      sender: {
        select: { id: true, name: true, accountId: true, clientId: true },
      },
    },
  });
  if (!row) return null;

  const draft = row.draft as unknown as JobSheetDraft;
  const sources = row.sources as unknown as Partial<Record<ReadableField, FieldSource>>;

  /*
   * Recomputed rather than stored. What a booking cannot do without is a
   * property of the form, not of the sheet, and storing the answer would mean
   * a sheet read last month still listing a field that is no longer required.
   */
  const missing = missingFrom(draft);

  return {
    id: row.id,
    fileName: row.fileName,
    draft,
    sources,
    missing,
    sender: row.sender,
    jobId: row.jobId,
  };
}

function missingFrom(draft: JobSheetDraft): string[] {
  const required: Array<[keyof JobSheetDraft, string]> = [
    ['scheduledDate', 'the pickup date'],
    ['scheduledTime', 'the pickup time'],
    ['pickupText', 'the pickup address'],
    ['dropoffText', 'the destination'],
  ];

  return required.filter(([key]) => !draft[key]).map(([, said]) => said);
}

/**
 * Tie a sheet to the job it produced, and learn from what the operator did.
 *
 * Called after the booking has succeeded and never allowed to fail it — a job
 * whose sheet is not attached is a missing link on a page, where a failed
 * attachment that took the booking with it is a lost fare. The caller logs and
 * carries on.
 */
export async function sheetBooked(
  sheetId: string,
  jobId: string,
  submitted: Partial<Record<ReadableField, string>>,
): Promise<void> {
  const row = await prisma.jobSheet.findUnique({
    where: { id: sheetId },
    select: { id: true, senderId: true, text: true, draft: true, sources: true },
  });
  if (!row) return;

  await prisma.jobSheet.update({
    where: { id: sheetId },
    data: { jobId, status: 'BOOKED' },
  });

  // Nothing to learn without a sender to learn it against. The labels are that
  // agency's wording, and applying them to everybody would be worse than
  // knowing nothing.
  if (!row.senderId) return;

  const lesson = lessonFrom(
    row.text,
    row.draft as unknown as JobSheetDraft,
    row.sources as unknown as Partial<Record<ReadableField, FieldSource>>,
    submitted,
  );

  const senderId = row.senderId;

  for (const { field, alias } of lesson.taught) {
    await prisma.sheetLabel.upsert({
      where: {
        senderId_field_label_placement: {
          senderId,
          field,
          label: alias.label,
          placement: PLACEMENT_TO_DB[alias.placement],
        },
      },
      create: {
        senderId,
        field,
        label: alias.label,
        placement: PLACEMENT_TO_DB[alias.placement],
        confirmed: 1,
        learnedFromSheetId: sheetId,
      },
      update: { confirmed: { increment: 1 } },
    });
  }

  await tally(senderId, lesson.kept, 'confirmed');
  await tally(senderId, lesson.changed, 'corrected');
}

/**
 * Record how a label fared.
 *
 * Only against labels that were learned: the built-in dictionary has no row to
 * tally, and would not be retired on one install's evidence anyway.
 */
async function tally(
  senderId: string,
  entries: Array<{ field: ReadableField; source: FieldSource }>,
  column: 'confirmed' | 'corrected',
): Promise<void> {
  for (const { field, source } of entries) {
    await prisma.sheetLabel.updateMany({
      where: {
        senderId,
        field,
        label: source.label,
        placement: PLACEMENT_TO_DB[source.placement],
      },
      data: { [column]: { increment: 1 } },
    });
  }
}

/** Mark a sheet deliberately not booked — a duplicate, or a cancellation. */
export async function discardSheet(sheetId: string): Promise<void> {
  await prisma.jobSheet.update({
    where: { id: sheetId },
    data: { status: 'DISCARDED' },
  });
}

export interface NewSender {
  name: string;
  /** Distinctive text from their sheets. Lowercased before it is stored. */
  fingerprint: string;
  accountId: string | null;
  clientId: string | null;
  createdById: string | null;
}

/**
 * Teach the install a sender.
 *
 * The entry point for an agency nobody has set up yet: the upload shows what it
 * read, says it does not know whose sheet this is, and asks who is billed.
 * From then on their sheets arrive with the account already filled in and their
 * labels accumulating.
 */
export async function createSender(input: NewSender): Promise<{ id: string }> {
  const fingerprint = input.fingerprint.trim().toLowerCase();

  if (fingerprint.length < 4) {
    throw new Error(
      'That is too short to identify a sender by — use their trading name as it appears on the sheet.',
    );
  }

  return prisma.sheetSender.create({
    data: {
      name: input.name.trim(),
      fingerprint,
      accountId: input.accountId,
      clientId: input.clientId,
      createdById: input.createdById,
    },
    select: { id: true },
  });
}

/** Attach an already-read sheet to a sender, and read it again with their labels. */
export async function assignSender(
  sheetId: string,
  senderId: string,
): Promise<SheetForForm | null> {
  const row = await prisma.jobSheet.findUnique({
    where: { id: sheetId },
    select: { text: true },
  });
  if (!row) return null;

  /*
   * Re-read rather than merely relabelled. This is what makes teaching
   * retrospective: the sheet that prompted somebody to add a sender is itself
   * read again with that sender's labels, so the operator sees the benefit on
   * the sheet in front of them rather than only on the next one.
   */
  const learned = await learnedAliases(senderId);
  const read = readJobSheet(row.text, { learned });

  await prisma.jobSheet.update({
    where: { id: sheetId },
    data: {
      senderId,
      draft: read.draft as unknown as Prisma.InputJsonValue,
      sources: read.sources as unknown as Prisma.InputJsonValue,
    },
  });

  return getSheet(sheetId);
}
