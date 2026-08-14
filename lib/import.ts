import { withAudit, type AuditContext } from './audit';
import { parseCsv, toCsv, type ParsedCsv } from './csv';
import {
  ENTITY_DEFS,
  templateExampleRow,
  templateHeaders,
  type ImportEntity,
} from './import-schema';
import {
  findDuplicatesInFile,
  validateClientRow,
  validateDriverRow,
  validateJobRow,
  validateVehicleRow,
  type ClientRow,
  type DriverRow,
  type JobRow,
  type RowError,
  type RowOutcome,
  type VehicleRow,
} from './import-rows';
import { prisma } from './prisma';
import { withDriverReference, withJobReference } from './references';
import { normaliseName } from './text';

/**
 * Loading a fresh install's records from a spreadsheet.
 *
 * Three properties matter more than speed, and shape everything here:
 *
 * 1. **The whole file is validated before anything is written.** An operator
 *    who uploads 195 drivers needs the list of problems in one go, not one
 *    error per attempt.
 * 2. **Valid rows import even when others fail.** Refusing the whole file for
 *    one bad date means the import never happens; they fix the four rows the
 *    report names and re-run.
 * 3. **Re-importing updates rather than duplicates.** The natural key is the
 *    registration, the phone number, or the name plus a contact — so running
 *    the same file twice is safe, which is what makes a correction workflow
 *    possible at all.
 */

export interface ImportSummary {
  entity: ImportEntity;
  fileName: string;
  created: number;
  updated: number;
  skipped: number;
  /** Every problem found, whether or not it stopped a row. */
  errors: RowError[];
  /** The first rows, for the preview. */
  preview: Array<Record<string, string>>;
  totalRows: number;
}

export const PREVIEW_ROWS = 20;

/** Which audit entity an import run is recorded against. */
const AUDIT_ENTITY = {
  drivers: 'Driver',
  vehicles: 'Vehicle',
  clients: 'Client',
  jobs: 'Job',
} as const;

/** The template a customer downloads: correct headers and one example row. */
export function buildTemplate(entity: ImportEntity): string {
  return toCsv([...templateHeaders(entity)], [templateExampleRow(entity)]);
}

/** The error report, as a file they can work through offline. */
export function buildErrorReport(summary: ImportSummary): string {
  return toCsv(
    ['row', 'column', 'problem'],
    summary.errors.map((error) => ({
      row: error.line,
      column: error.column ?? '',
      problem: error.message,
    })),
  );
}

interface Validated<T> {
  parsed: ParsedCsv;
  outcomes: Array<RowOutcome<T>>;
  errors: RowError[];
}

function validateAll<T>(
  text: string,
  validate: (row: Record<string, string>, line: number) => RowOutcome<T>,
  keyOf: (value: T) => string,
): Validated<T> {
  const parsed = parseCsv(text);
  const outcomes = parsed.rows.map((row, index) =>
    validate(row, parsed.lineNumbers[index] ?? index + 2),
  );

  const errors = outcomes.flatMap((outcome) => outcome.errors);
  const duplicates = findDuplicatesInFile(outcomes, keyOf);

  // A duplicate is reported *and* skipped: the first occurrence wins, so the
  // second is marked so it does not silently overwrite it.
  const duplicateLines = new Set(duplicates.map((error) => error.line));
  for (const outcome of outcomes) {
    if (duplicateLines.has(outcome.line)) outcome.value = null;
  }

  return { parsed, outcomes, errors: [...errors, ...duplicates] };
}

/**
 * Validate without writing anything.
 *
 * The preview and the real import share `validateAll`, so a row the preview
 * calls fine cannot be one the import then refuses.
 */
export function dryRun(entity: ImportEntity, text: string): ImportSummary {
  const validated = validateForEntity(entity, text);

  return {
    entity,
    fileName: '',
    created: 0,
    updated: 0,
    skipped: validated.outcomes.filter((outcome) => !outcome.value).length,
    errors: validated.errors,
    preview: validated.parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: validated.parsed.rows.length,
  };
}

function validateForEntity(
  entity: ImportEntity,
  text: string,
):
  | Validated<DriverRow>
  | Validated<VehicleRow>
  | Validated<ClientRow>
  | Validated<JobRow> {
  switch (entity) {
    case 'drivers':
      return validateAll(text, validateDriverRow, (row) => row.normalisedPhone);
    case 'vehicles':
      return validateAll(
        text,
        validateVehicleRow,
        (row) => row.normalisedRegistration,
      );
    case 'clients':
      return validateAll(text, validateClientRow, (row) => row.matchKey);
    case 'jobs':
      return validateAll(text, validateJobRow, (row) => row.matchKey);
  }
}

export async function runImport(
  entity: ImportEntity,
  text: string,
  fileName: string,
  context: AuditContext,
): Promise<ImportSummary> {
  const base = {
    entity,
    fileName,
    preview: [] as Array<Record<string, string>>,
    totalRows: 0,
  };

  const result =
    entity === 'drivers'
      ? await importDrivers(text)
      : entity === 'vehicles'
        ? await importVehicles(text)
        : entity === 'clients'
          ? await importClients(text)
          : await importJobs(text);

  const summary: ImportSummary = { ...base, ...result };

  // Recorded whatever the outcome, including a run that imported nothing:
  // "who loaded this and when" is the question asked six months later.
  await withAudit(
    AUDIT_ENTITY[entity],
    'create',
    async () => ({
      entityId: `import:${entity}`,
      after: {
        fileName,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped,
        totalRows: summary.totalRows,
        errorCount: summary.errors.length,
      },
      result: null,
    }),
    context,
  );

  return summary;
}

type Counts = Pick<
  ImportSummary,
  'created' | 'updated' | 'skipped' | 'errors' | 'preview' | 'totalRows'
>;

async function importVehicles(text: string): Promise<Counts> {
  const { parsed, outcomes, errors } = validateAll(
    text,
    validateVehicleRow,
    (row) => row.normalisedRegistration,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const runtimeErrors: RowError[] = [];

  for (const outcome of outcomes) {
    if (!outcome.value) {
      skipped += 1;
      continue;
    }
    const row = outcome.value;

    try {
      const existing = await prisma.vehicle.findFirst({
        where: { normalisedRegistration: row.normalisedRegistration },
        select: { id: true },
      });

      const data = {
        registration: row.registration,
        normalisedRegistration: row.normalisedRegistration,
        make: row.make,
        model: row.model,
        variant: row.variant,
        colour: row.colour,
        vehicleClass: row.vehicleClass,
        seats: row.seats,
        ownership: row.ownership,
        motExpiry: row.motExpiry,
        insuranceExpiry: row.insuranceExpiry,
        phvLicenceExpiry: row.phvLicenceExpiry,
        phvLicenceNumber: row.phvLicenceNumber,
        insurancePolicyNo: row.insurancePolicyNo,
        status: row.status,
      };

      if (existing) {
        await prisma.vehicle.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.vehicle.create({ data });
        created += 1;
      }
    } catch (error) {
      skipped += 1;
      runtimeErrors.push({
        line: outcome.line,
        column: null,
        message: describe(error),
      });
    }
  }

  return {
    created,
    updated,
    skipped,
    errors: [...errors, ...runtimeErrors],
    preview: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.rows.length,
  };
}

async function importDrivers(text: string): Promise<Counts> {
  const { parsed, outcomes, errors } = validateAll(
    text,
    validateDriverRow,
    (row) => row.normalisedPhone,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const runtimeErrors: RowError[] = [];

  for (const outcome of outcomes) {
    if (!outcome.value) {
      skipped += 1;
      continue;
    }
    const row = outcome.value;

    try {
      // Spec 3.5.7: the driver file may name a vehicle by registration,
      // linking the two in one pass. A registration that is not on the fleet
      // is reported rather than failing the row — the driver is still worth
      // importing, and the vehicle file may simply not have been loaded yet.
      let assignedVehicleId: string | null = null;
      if (row.vehicleRegistration) {
        const vehicle = await prisma.vehicle.findFirst({
          where: {
            normalisedRegistration: row.vehicleRegistration
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, ''),
          },
          select: { id: true },
        });
        if (vehicle) {
          assignedVehicleId = vehicle.id;
        } else {
          runtimeErrors.push({
            line: outcome.line,
            column: 'vehicle_registration',
            message: `No vehicle "${row.vehicleRegistration}" on the fleet. The driver was imported without one — load the vehicles first, then re-run this file.`,
          });
        }
      }

      const existing = await prisma.driver.findFirst({
        where: { normalisedPhone: row.normalisedPhone },
        select: { id: true },
      });

      const data = {
        name: row.name,
        phone: row.phone,
        normalisedPhone: row.normalisedPhone,
        email: row.email,
        dvlaLicenceExpiry: row.dvlaLicenceExpiry,
        phvBadgeExpiry: row.phvBadgeExpiry,
        status: row.status,
        notes: row.notes,
        ...(assignedVehicleId ? { assignedVehicleId } : {}),
      };

      if (existing) {
        await prisma.driver.update({ where: { id: existing.id }, data });
        updated += 1;
      } else if (row.reference) {
        await prisma.driver.create({ data: { ...data, reference: row.reference } });
        created += 1;
      } else {
        // Retries on the unique-constraint race, so two rows importing at the
        // same moment cannot end up sharing a number.
        await withDriverReference((reference) =>
          prisma.driver.create({ data: { ...data, reference } }),
        );
        created += 1;
      }
    } catch (error) {
      skipped += 1;
      runtimeErrors.push({
        line: outcome.line,
        column: null,
        message: describe(error),
      });
    }
  }

  return {
    created,
    updated,
    skipped,
    errors: [...errors, ...runtimeErrors],
    preview: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.rows.length,
  };
}

async function importClients(text: string): Promise<Counts> {
  const { parsed, outcomes, errors } = validateAll(
    text,
    validateClientRow,
    (row) => row.matchKey,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const runtimeErrors: RowError[] = [];

  for (const outcome of outcomes) {
    if (!outcome.value) {
      skipped += 1;
      continue;
    }
    const row = outcome.value;

    try {
      // Name alone would merge two different people called John Smith, so a
      // contact detail is part of the match where there is one.
      const existing = await prisma.client.findFirst({
        where: {
          normalisedName: row.normalisedName,
          ...(row.contactEmail
            ? { contactEmail: row.contactEmail }
            : row.contactPhone
              ? { contactPhone: row.contactPhone }
              : {}),
        },
        select: { id: true },
      });

      const data = {
        name: row.name,
        normalisedName: row.normalisedName,
        contactEmail: row.contactEmail,
        contactPhone: row.contactPhone,
        billingEmail: row.billingEmail,
        billingAddress: row.billingAddress,
        vatNumber: row.vatNumber,
        paymentTermsDays: row.paymentTermsDays,
        notes: row.notes,
      };

      if (existing) {
        await prisma.client.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.client.create({ data });
        created += 1;
      }
    } catch (error) {
      skipped += 1;
      runtimeErrors.push({
        line: outcome.line,
        column: null,
        message: describe(error),
      });
    }
  }

  return {
    created,
    updated,
    skipped,
    errors: [...errors, ...runtimeErrors],
    preview: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.rows.length,
  };
}

/**
 * Historical jobs.
 *
 * This is the one place in the product that writes a job straight into a
 * terminal status. Everywhere else a job walks the lifecycle in
 * `lib/job-status.ts` and is refused if it tries to skip a step or complete
 * without a price. Both of those guards protect *dispatch* — work that has
 * yet to happen. This file describes work that already did, where the driver
 * demonstrably drove and the money was or was not recorded years ago.
 *
 * So the lifecycle is bypassed, deliberately and only here, and the two
 * things the guards were protecting are preserved by other means:
 *
 * - **Price.** A completed job still cannot arrive with no client price and
 *   no explanation; `validateJobRow` refuses the row. The reason is stored on
 *   the job, so the unpriced-work views show it exactly as they would show a
 *   zero-value job booked today.
 * - **Compliance.** The expiry checks are not run, because they would refuse
 *   every historical row — an imported driver has no expiry dates yet, and
 *   "unknown" counts as non-compliant. Refusing here would mean recording
 *   that nobody drove, which is worse than recording who did.
 *
 * Nothing else in the system gains this power: the bypass lives in this
 * function, not in a flag on the job.
 */
async function importJobs(text: string): Promise<Counts> {
  const { parsed, outcomes, errors } = validateAll(
    text,
    validateJobRow,
    (row) => row.matchKey,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const runtimeErrors: RowError[] = [];

  // Resolved once for the whole file. A 900-row import would otherwise ask
  // the database for the same driver hundreds of times.
  const [clients, accounts, drivers, vehicles] = await Promise.all([
    prisma.client.findMany({ select: { id: true, normalisedName: true } }),
    prisma.account.findMany({ select: { id: true, name: true } }),
    prisma.driver.findMany({ select: { id: true, name: true, normalisedPhone: true } }),
    prisma.vehicle.findMany({ select: { id: true, normalisedRegistration: true } }),
  ]);

  const clientByName = new Map(clients.map((c) => [c.normalisedName, c.id]));
  const accountByName = new Map(accounts.map((a) => [normaliseName(a.name), a.id]));
  const driverByPhone = new Map(drivers.map((d) => [d.normalisedPhone, d.id]));
  const driverByName = new Map(drivers.map((d) => [normaliseName(d.name), d.id]));
  const vehicleByReg = new Map(vehicles.map((v) => [v.normalisedRegistration, v.id]));

  for (const outcome of outcomes) {
    if (!outcome.value) {
      skipped += 1;
      continue;
    }
    const row = outcome.value;

    // A link that cannot be resolved is reported and the job still imports.
    // A job with no client is a real thing in this data; a job that was
    // dropped because its passenger's name was spelled differently is not.
    const missing = (column: string, message: string) =>
      runtimeErrors.push({ line: outcome.line, column, message });

    let clientId: string | null = null;
    if (row.clientName) {
      clientId = clientByName.get(normaliseName(row.clientName)) ?? null;
      if (!clientId) {
        missing('client_name', `No client "${row.clientName}". Imported without one.`);
      }
    }

    let accountId: string | null = null;
    if (row.accountName) {
      accountId = accountByName.get(normaliseName(row.accountName)) ?? null;
      if (!accountId) {
        missing('account_name', `No account "${row.accountName}". Imported without one.`);
      }
    }

    let driverId: string | null = null;
    if (row.normalisedDriverPhone) {
      driverId = driverByPhone.get(row.normalisedDriverPhone) ?? null;
    }
    if (!driverId && row.driverName) {
      driverId = driverByName.get(normaliseName(row.driverName)) ?? null;
    }
    if (!driverId && (row.driverPhone || row.driverName)) {
      missing(
        'driver_phone',
        `No driver matching "${row.driverName ?? row.driverPhone}". Imported without one.`,
      );
    }

    let vehicleId: string | null = null;
    if (row.vehicleRegistration) {
      vehicleId = vehicleByReg.get(row.vehicleRegistration) ?? null;
      if (!vehicleId) {
        missing(
          'vehicle_registration',
          `No vehicle "${row.vehicleRegistration}" on the fleet. Imported without one.`,
        );
      }
    }

    const internalNotes = [
      row.legacyReference ? `Legacy reference ${row.legacyReference}` : '',
      'Imported from a historical job file',
      row.timeAssumed ? 'Time of day not recorded; set to midday' : '',
    ]
      .filter(Boolean)
      .join('. ');

    const data = {
      clientId,
      accountId,
      jobType: row.jobType,
      status: row.status,
      scheduledAt: row.scheduledAt,
      pickupText: row.pickupText,
      dropoffText: row.dropoffText,
      driverId,
      vehicleId,
      passengerName: row.passengerName,
      passengerPhone: row.passengerPhone,
      clientPricePence: row.clientPricePence,
      driverPricePence: row.driverPricePence,
      zeroValueReason: row.zeroValueReason,
      notes: row.notes,
      internalNotes,
    };

    try {
      // Re-importing the same file must not double the history, and the old
      // references cannot be used to tell — so the match is on what actually
      // identifies a run.
      //
      // A window rather than an exact time, because a corrected spreadsheet
      // may nudge a pickup by a few minutes and that is the same job. Narrow
      // enough that a morning run and an afternoon one stay two jobs; wide
      // enough that a small correction updates rather than duplicates.
      const existing = await prisma.job.findFirst({
        where: {
          scheduledAt: {
            gte: new Date(row.scheduledAt.getTime() - 90 * 60 * 1000),
            lte: new Date(row.scheduledAt.getTime() + 90 * 60 * 1000),
          },
          pickupText: row.pickupText,
          dropoffText: row.dropoffText,
          driverId,
          clientId,
        },
        select: { id: true },
      });

      if (existing) {
        await withAudit(
          'Job',
          'update',
          async (tx) => {
            const before = await tx.job.findUnique({ where: { id: existing.id } });
            const after = await tx.job.update({ where: { id: existing.id }, data });
            return { entityId: existing.id, before, after, result: null };
          },
        );
        updated += 1;
      } else {
        await withJobReference((reference) =>
          withAudit(
            'Job',
            'create',
            async (tx) => {
              const job = await tx.job.create({ data: { ...data, reference } });
              // The events a job would have emitted on its way through the
              // lifecycle, written at the time it actually ran — otherwise
              // the history has jobs that completed without ever starting.
              if (row.status === 'COMPLETED') {
                await tx.jobEvent.createMany({
                  // SYSTEM, not USER: nobody pressed a button for these. The
                  // actor is the import, and the timeline should say so.
                  data: [
                    {
                      jobId: job.id,
                      type: 'ASSIGNED',
                      actorType: 'SYSTEM',
                      occurredAt: row.scheduledAt,
                    },
                    {
                      jobId: job.id,
                      type: 'COMPLETED',
                      actorType: 'SYSTEM',
                      occurredAt: row.scheduledAt,
                    },
                  ],
                });
              }
              return { entityId: job.id, before: null, after: job, result: null };
            },
          ),
        );
        created += 1;
      }
    } catch (error) {
      skipped += 1;
      runtimeErrors.push({
        line: outcome.line,
        column: null,
        message: describe(error),
      });
    }
  }

  return {
    created,
    updated,
    skipped,
    errors: [...errors, ...runtimeErrors],
    preview: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.rows.length,
  };
}

/** A database error, said in a way the person holding the spreadsheet can use. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('Unique constraint')) {
      return 'Another record already holds one of these values. Check the reference and email columns.';
    }
    return error.message.split('\n')[0]?.slice(0, 200) ?? 'That row failed';
  }
  return 'That row failed';
}

export { ENTITY_DEFS };
