/**
 * What each import file may contain, and what it means.
 *
 * The column definitions live apart from the import machinery so the same
 * list drives three things that must never disagree: the template a customer
 * downloads, the validation their upload is judged against, and the
 * documentation of the format. When those drift, an operator fills in a
 * template that the importer then rejects.
 *
 * Imports nothing, so a Client Component can render the column reference.
 */

export type ImportEntity = 'drivers' | 'vehicles' | 'clients' | 'jobs';

export interface ColumnDef {
  /** Normalised header, per `normaliseHeader` in `lib/csv.ts`. */
  key: string;
  /** What the template writes, and what a person reads. */
  label: string;
  required?: boolean;
  /** Shown in the template's example row and in the column reference. */
  example: string;
  hint?: string;
}

export interface EntityDef {
  entity: ImportEntity;
  label: string;
  /** What makes two rows the same record, in words. */
  naturalKey: string;
  columns: ColumnDef[];
}

const EXPIRY_HINT = 'YYYY-MM-DD. Blank is allowed and lands in the compliance backlog.';

export const DRIVER_COLUMNS: ColumnDef[] = [
  {
    key: 'name',
    label: 'name',
    required: true,
    example: 'Sam Okafor',
  },
  {
    key: 'phone',
    label: 'phone',
    required: true,
    example: '07700 900123',
    hint: 'The natural key. Re-importing the same phone updates that driver.',
  },
  { key: 'email', label: 'email', example: 'sam@example.com' },
  {
    key: 'reference',
    label: 'reference',
    example: 'DRV-0147',
    hint: 'Leave blank to have one allocated.',
  },
  {
    key: 'dvlalicenceexpiry',
    label: 'dvla_licence_expiry',
    example: '2028-04-30',
    hint: EXPIRY_HINT,
  },
  {
    key: 'phvbadgeexpiry',
    label: 'phv_badge_expiry',
    example: '2027-11-15',
    hint: EXPIRY_HINT,
  },
  {
    key: 'vehicleregistration',
    label: 'vehicle_registration',
    example: 'AB12 CDE',
    hint: 'Links this driver to a vehicle already on the fleet, or one in the vehicle file.',
  },
  {
    key: 'status',
    label: 'status',
    example: 'ACTIVE',
    hint: 'ACTIVE, INACTIVE or SUSPENDED. Defaults to ACTIVE.',
  },
  { key: 'notes', label: 'notes', example: 'Prefers airport work' },
];

export const VEHICLE_COLUMNS: ColumnDef[] = [
  {
    key: 'registration',
    label: 'registration',
    required: true,
    example: 'AB12 CDE',
    hint: 'The natural key. Spacing and case do not matter for matching.',
  },
  { key: 'make', label: 'make', required: true, example: 'Mercedes-Benz' },
  { key: 'model', label: 'model', required: true, example: 'E-Class' },
  { key: 'variant', label: 'variant', example: 'AMG Line' },
  { key: 'colour', label: 'colour', example: 'Obsidian black' },
  {
    key: 'class',
    label: 'class',
    example: 'EXECUTIVE',
    hint: 'SALOON, EXECUTIVE, LUXURY, MPV, SUV or ELECTRIC_EXECUTIVE.',
  },
  { key: 'seats', label: 'seats', example: '4' },
  {
    key: 'ownership',
    label: 'ownership',
    example: 'DRIVER_OWNED',
    hint: 'OWNED, FINANCED, LEASED or DRIVER_OWNED. Defaults to DRIVER_OWNED.',
  },
  {
    key: 'motexpiry',
    label: 'mot_expiry',
    example: '2027-02-28',
    hint: EXPIRY_HINT,
  },
  {
    key: 'insuranceexpiry',
    label: 'insurance_expiry',
    example: '2027-06-30',
    hint: EXPIRY_HINT,
  },
  {
    key: 'phvlicenceexpiry',
    label: 'phv_licence_expiry',
    example: '2027-09-30',
    hint: EXPIRY_HINT,
  },
  { key: 'phvlicencenumber', label: 'phv_licence_number', example: '123456' },
  { key: 'insurancepolicyno', label: 'insurance_policy_no', example: 'POL-887766' },
  {
    key: 'status',
    label: 'status',
    example: 'ACTIVE',
    hint: 'ACTIVE, OFF_ROAD or RETIRED. Defaults to ACTIVE.',
  },
];

export const CLIENT_COLUMNS: ColumnDef[] = [
  {
    key: 'name',
    label: 'name',
    required: true,
    example: 'Northwind Trading',
    hint: 'Part of the natural key, together with the email or phone.',
  },
  {
    key: 'contactemail',
    label: 'contact_email',
    example: 'bookings@example.com',
  },
  { key: 'contactphone', label: 'contact_phone', example: '020 7946 0000' },
  {
    key: 'billingemail',
    label: 'billing_email',
    example: 'accounts@example.com',
    hint: 'Where invoices go, if it differs from the booking contact.',
  },
  {
    key: 'billingaddress',
    label: 'billing_address',
    example: '1 Example Street, London',
  },
  { key: 'vatnumber', label: 'vat_number', example: 'GB123456789' },
  {
    key: 'paymenttermsdays',
    label: 'payment_terms_days',
    example: '14',
    hint: 'Whole days. Defaults to 14.',
  },
  { key: 'notes', label: 'notes', example: 'Always books via the PA' },
];

/**
 * Work that already happened.
 *
 * This file is a backfill, not a booking channel, and the difference shows in
 * two columns that exist nowhere else in the product. `status` is written
 * directly rather than reached through the lifecycle, and `zero_value_reason`
 * carries the explanation that a completed job with no price is required to
 * have. Both are safe *because* it is history: nothing here dispatches a car.
 */
export const JOB_COLUMNS: ColumnDef[] = [
  {
    key: 'date',
    label: 'date',
    required: true,
    example: '2026-03-14',
    hint: 'YYYY-MM-DD, or DD/MM/YYYY. The day the job ran.',
  },
  {
    key: 'time',
    label: 'time',
    example: '14:30',
    hint: '24-hour, in local time. Blank means the day is known and the hour is not.',
  },
  {
    key: 'jobtype',
    label: 'job_type',
    required: true,
    example: 'TRANSFER',
    hint: 'TRANSFER, AIRPORT_TRANSFER or AS_DIRECTED.',
  },
  {
    key: 'status',
    label: 'status',
    example: 'COMPLETED',
    hint: 'COMPLETED, CANCELLED or NO_SHOW. Defaults to COMPLETED.',
  },
  { key: 'pickup', label: 'pickup', required: true, example: 'The Savoy, Strand' },
  { key: 'dropoff', label: 'dropoff', required: true, example: 'Heathrow T5' },
  {
    key: 'clientname',
    label: 'client_name',
    example: 'Mr Yinka',
    hint: 'Who rode. Matched to an existing client by name; unmatched names are reported, not created.',
  },
  {
    key: 'accountname',
    label: 'account_name',
    example: 'Montclares',
    hint: 'Who is invoiced. Matched to an existing account by name.',
  },
  {
    key: 'driverphone',
    label: 'driver_phone',
    example: '07700 900123',
    hint: 'Matches the driver imported from the driver file. More reliable than the name.',
  },
  {
    key: 'drivername',
    label: 'driver_name',
    example: 'Sam Okafor',
    hint: 'Used only when the phone is blank or matches nothing.',
  },
  {
    key: 'vehicleregistration',
    label: 'vehicle_registration',
    example: 'AB12 CDE',
  },
  {
    key: 'clientprice',
    label: 'client_price',
    example: '165.50',
    hint: 'In pounds, as written on the sheet. Stored in pence.',
  },
  {
    key: 'driverprice',
    label: 'driver_price',
    example: '105.00',
    hint: 'What the driver was paid, in pounds.',
  },
  {
    key: 'zerovaluereason',
    label: 'zero_value_reason',
    example: 'Imported from legacy sheet, no client price recorded',
    hint: 'Required to complete a job with no client price. The importer will not invent one.',
  },
  { key: 'passengername', label: 'passenger_name', example: 'Mr Yinka' },
  { key: 'passengerphone', label: 'passenger_phone', example: '07700 900456' },
  {
    key: 'legacyreference',
    label: 'legacy_reference',
    example: 'WL 0562',
    hint: 'The old system’s number. Kept in internal notes; the system allocates its own reference.',
  },
  { key: 'notes', label: 'notes', example: 'Client asked for bottled water' },
];

export const ENTITY_DEFS: Record<ImportEntity, EntityDef> = {
  drivers: {
    entity: 'drivers',
    label: 'Drivers',
    naturalKey: 'phone number',
    columns: DRIVER_COLUMNS,
  },
  vehicles: {
    entity: 'vehicles',
    label: 'Vehicles',
    naturalKey: 'registration',
    columns: VEHICLE_COLUMNS,
  },
  clients: {
    entity: 'clients',
    label: 'Clients',
    naturalKey: 'name plus email or phone',
    columns: CLIENT_COLUMNS,
  },
  jobs: {
    entity: 'jobs',
    label: 'Jobs (historical)',
    // No reference to key on: the old system reused its numbers, so identity
    // has to come from what actually distinguishes one run from another.
    naturalKey: 'date, pickup, dropoff and driver',
    columns: JOB_COLUMNS,
  },
};

export const IMPORT_ENTITIES = Object.keys(ENTITY_DEFS) as ImportEntity[];

export function isImportEntity(value: string): value is ImportEntity {
  return (IMPORT_ENTITIES as string[]).includes(value);
}

/** The template's header row, in the order a person would expect them. */
export function templateHeaders(entity: ImportEntity): string[] {
  return ENTITY_DEFS[entity].columns.map((column) => column.label);
}

/** One example row, so the format of every column is unambiguous. */
export function templateExampleRow(
  entity: ImportEntity,
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const column of ENTITY_DEFS[entity].columns) {
    row[column.label] = column.example;
  }
  return row;
}
