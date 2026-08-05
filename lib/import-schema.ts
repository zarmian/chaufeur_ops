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

export type ImportEntity = 'drivers' | 'vehicles' | 'clients';

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
