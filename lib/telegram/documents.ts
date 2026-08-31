import { DOCUMENT_TYPES, requiresExpiry, recordDocument } from '../documents';
import { formatDate, fromDateOnlyString } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { prisma } from '../prisma';
import { buildObjectKey, isStorageConfigured, upload } from '../storage';
import { beginConversation, endConversation } from './expenses';
import { downloadFile, getFilePath, sendMessage } from './send';
import { encodeCallback, escapeMarkdown } from './protocol';
import type { InlineButton } from './send';

/**
 * A driver filing their own compliance documents.
 *
 * The bot already chases these: at 30, 14 and 7 days, then daily once
 * something has lapsed, with a message that names the document and the date
 * and asks for a photo. What it could not do until now is take the photo. A
 * driver who wants to comply has had to email the office, or hand it over at
 * the next job, or send it to somebody's personal WhatsApp — and the chasing
 * carries on in the meantime, because nothing in the system knows.
 *
 * That is the gap this closes, and the reason it is worth the machinery: an
 * expired PHV badge or a lapsed insurance certificate **blocks assignment**.
 * A driver who cannot file a renewal in the two minutes they have is a driver
 * who cannot be given work tomorrow.
 *
 * The expiry date is asked for and not guessed. Compliance is judged on that
 * date, and a document filed without one counts as non-compliant rather than
 * valid — so a flow that quietly stored the photo alone would look like
 * success and change nothing.
 */

/** What a driver can file about themselves, and about the car they drive. */
const DRIVER_DOCUMENTS = ['DVLA_LICENCE', 'PHV_BADGE', 'DBS'] as const;
const VEHICLE_DOCUMENTS = ['PHV_VEHICLE', 'MOT', 'INSURANCE', 'V5_LOGBOOK'] as const;

export type FilableDocument =
  | (typeof DRIVER_DOCUMENTS)[number]
  | (typeof VEHICLE_DOCUMENTS)[number];

const FILABLE: readonly string[] = [...DRIVER_DOCUMENTS, ...VEHICLE_DOCUMENTS];

export function isFilable(type: string): type is FilableDocument {
  return FILABLE.includes(type);
}

export function belongsToVehicle(type: FilableDocument): boolean {
  return (VEHICLE_DOCUMENTS as readonly string[]).includes(type);
}

/** The label the operator sees on the dashboard, so both agree. */
function label(type: string): string {
  return DOCUMENT_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

/** Two to a row: the labels are long and a phone is narrow. */
export function documentKeyboard(): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < FILABLE.length; i += 2) {
    rows.push(
      FILABLE.slice(i, i + 2).map((type) => ({
        text: label(type),
        callbackData: encodeCallback({ kind: 'document-type', documentType: type }),
      })),
    );
  }
  return rows;
}

export interface DocumentOutcome {
  kind: string;
  outcome: string;
}

/**
 * A photo the driver wants filed as a document.
 *
 * Stored first, asked about second. The alternative — ask which document,
 * then ask them to send the photo — loses the photo they have already taken,
 * and a driver who has to take it twice does not.
 */
export async function beginDocumentFiling(
  chatId: bigint,
  driverId: string,
  photo: Array<{ file_id?: string; file_size?: number }>,
): Promise<DocumentOutcome> {
  if (!isStorageConfigured()) {
    await sendMessage(
      chatId,
      escapeMarkdown(
        'Document storage is not set up yet, so I cannot keep the photo. Send it to the office instead.',
      ),
    );
    return { kind: 'document', outcome: 'storage not configured' };
  }

  const largest = [...photo]
    .filter((size) => size.file_id)
    .sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
  if (!largest?.file_id) return { kind: 'document', outcome: 'no usable size' };

  const path = await getFilePath(largest.file_id);
  const bytes = path ? await downloadFile(path) : null;
  if (!bytes) {
    await sendMessage(
      chatId,
      escapeMarkdown('I could not fetch that photo. Try sending it again.'),
    );
    return { kind: 'document', outcome: 'download failed' };
  }

  /*
   * Parked under the driver until the type is known.
   *
   * A vehicle document ends up on the vehicle, but which vehicle depends on
   * an answer the driver has not given yet, and the object has to live
   * somewhere in the meantime. `recordDocument` is given this key, so the
   * stored pathname and the row always agree — even for a vehicle document
   * filed by its driver, where the key says `driver` and the row says
   * vehicle. The key is a name, not the authority on ownership.
   */
  const key = buildObjectKey('driver', driverId, 'document.jpg');

  try {
    await upload(Buffer.from(bytes), key, 'image/jpeg');
  } catch (error) {
    await sendMessage(
      chatId,
      escapeMarkdown('I could not store that photo. Send it to the office instead.'),
    );
    return {
      kind: 'document',
      outcome: `upload failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  await beginConversation(chatId, 'document_type', {
    fileKey: key,
    sizeBytes: bytes.byteLength,
  });
  await sendMessage(chatId, escapeMarkdown('What is this?'), {
    buttons: documentKeyboard(),
  });

  return { kind: 'document', outcome: 'awaiting type' };
}

/** The type has been chosen. Ask for the date, or file it now. */
export async function setDocumentType(
  chatId: bigint,
  driverId: string,
  fileKey: string,
  sizeBytes: number,
  type: string,
): Promise<DocumentOutcome> {
  if (!isFilable(type)) {
    return { kind: 'document-type', outcome: 'not a filable type' };
  }

  if (belongsToVehicle(type)) {
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { assignedVehicleId: true },
    });
    if (!driver?.assignedVehicleId) {
      // Spec: a driver has one assigned vehicle, but a job may override it.
      // Filing against a vehicle they are not assigned to would put an
      // insurance certificate on somebody else's car.
      await endConversation(chatId);
      await sendMessage(
        chatId,
        escapeMarkdown(
          'You have no vehicle assigned, so I do not know which car this belongs to. Send it to the office.',
        ),
      );
      return { kind: 'document-type', outcome: 'no assigned vehicle' };
    }
  }

  if (!requiresExpiry(type as never)) {
    return fileDocument(chatId, driverId, fileKey, sizeBytes, type, null);
  }

  await beginConversation(chatId, 'document_expiry', { fileKey, sizeBytes, type });
  await sendMessage(
    chatId,
    escapeMarkdown(
      `When does that ${label(type)} expire? Send the date as DD/MM/YYYY.`,
    ),
  );
  return { kind: 'document-type', outcome: `awaiting expiry for ${type}` };
}

/**
 * A date a driver typed.
 *
 * `DD/MM/YYYY` first, because that is how the date is printed on every UK
 * document this flow exists for. `YYYY-MM-DD` accepted too, because somebody
 * will type it. Anything else is asked again rather than guessed: a
 * misread expiry is a compliance date that is wrong in the one direction
 * nobody checks.
 */
export function parseTypedDate(input: string): string | null {
  const text = input.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return isRealDate(+iso[1]!, +iso[2]!, +iso[3]!) ? text : null;

  const uk = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(text);
  if (!uk) return null;

  const day = Number(uk[1]);
  const month = Number(uk[2]);
  const rawYear = Number(uk[3]);
  // A two-digit year on a document that expires is this century.
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;

  if (!isRealDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Rejects 31 February rather than rolling it into March.
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** The date has been typed. File it. */
export async function handleDocumentExpiry(
  chatId: bigint,
  driverId: string,
  fileKey: string,
  sizeBytes: number,
  type: string,
  typed: string,
): Promise<DocumentOutcome> {
  const parsed = parseTypedDate(typed);
  if (!parsed) {
    await sendMessage(
      chatId,
      escapeMarkdown('I could not read that date. Send it as DD/MM/YYYY — 04/09/2027.'),
    );
    return { kind: 'document-expiry', outcome: 'unparsed date' };
  }

  return fileDocument(chatId, driverId, fileKey, sizeBytes, type, parsed);
}

/** Write the row, against the driver or the car they drive. */
async function fileDocument(
  chatId: bigint,
  driverId: string,
  fileKey: string,
  sizeBytes: number,
  type: string,
  expiresOn: string | null,
): Promise<DocumentOutcome> {
  if (!isFilable(type)) {
    await endConversation(chatId);
    return { kind: 'document', outcome: 'not a filable type' };
  }

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { assignedVehicleId: true },
  });

  const owner = belongsToVehicle(type)
    ? { vehicleId: driver?.assignedVehicleId ?? undefined }
    : { driverId };

  if (belongsToVehicle(type) && !owner.vehicleId) {
    await endConversation(chatId);
    await sendMessage(
      chatId,
      escapeMarkdown('You have no vehicle assigned, so I cannot file that here.'),
    );
    return { kind: 'document', outcome: 'no assigned vehicle' };
  }

  await recordDocument(
    owner,
    {
      type: type as never,
      issuedOn: '',
      expiresOn: expiresOn ?? '',
      // Supersede rather than pile up. A renewal replaces the certificate it
      // renews, and the old one is kept as the reason a job last month was
      // compliant.
      mode: 'replace',
    },
    {
      key: fileKey,
      fileName: `${type.toLowerCase()}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes,
    },
    // No acting user: the driver filed it, and drivers are not users.
    {},
  );

  await endConversation(chatId);

  const locale = await getLocaleConfig();
  const when = expiresOn
    ? ` It expires ${formatDate(fromDateOnlyString(expiresOn), locale)}.`
    : '';

  await sendMessage(
    chatId,
    escapeMarkdown(`Filed your ${label(type)}.${when} Thank you.`),
  );

  return { kind: 'document', outcome: `filed ${type}` };
}
