import {
  normaliseName,
  normalisePhone,
  normaliseRegistration,
  tidy,
} from './text';

/**
 * Turning a spreadsheet row into something the database will accept, or
 * saying precisely why it will not.
 *
 * Separate from the database work so it can be tested exhaustively without
 * one, and so the preview and the real import judge a row identically — a
 * preview that says "fine" followed by an import that says "no" is worse than
 * no preview at all.
 *
 * The rule throughout: a missing date is *not* an error. The legacy system's
 * whole problem was documents with no dates, and refusing those rows would
 * mean the operator either never imports or invents dates to get past the
 * validator. They import, and land in the compliance backlog where they
 * belong.
 */

export interface RowError {
  /** 1-based line in the uploaded file. */
  line: number;
  column: string | null;
  message: string;
}

export interface RowOutcome<T> {
  line: number;
  value: T | null;
  errors: RowError[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accepts `2027-06-30`, `30/06/2027` and `30-06-2027`.
 *
 * Day-first for the ambiguous slash form, because this is a UK product and
 * `06/07/2027` from a British spreadsheet means July. Guessing the other way
 * would put an MOT expiry eleven months out and nobody would notice until it
 * lapsed.
 */
export function parseImportDate(
  raw: string,
): { ok: true; value: Date | null } | { ok: false; message: string } {
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };

  if (DATE_ONLY.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, message: `"${raw}" is not a real date` };
    }
    return { ok: true, value: date };
  }

  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (slashed) {
    const day = Number(slashed[1]);
    const month = Number(slashed[2]);
    const year = Number(slashed[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { ok: false, message: `"${raw}" is not a real date` };
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    // Rolls over on 31 February, which means the date did not exist.
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return { ok: false, message: `"${raw}" is not a real date` };
    }
    return { ok: true, value: date };
  }

  return {
    ok: false,
    message: `"${raw}" is not a date the importer understands. Use YYYY-MM-DD.`,
  };
}

// `normalisePhone` comes from `lib/text.ts`, which already documents it as
// the natural key for driver imports. A second implementation here would
// eventually disagree with it about which two numbers are the same number.

function enumValue<T extends string>(
  raw: string,
  allowed: readonly T[],
  fallback: T,
): { ok: true; value: T } | { ok: false; message: string } {
  const value = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (value === '') return { ok: true, value: fallback };
  if ((allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    message: `"${raw}" is not one of ${allowed.join(', ')}`,
  };
}

// ------------------------------------------------------------------ drivers

export interface DriverRow {
  name: string;
  phone: string;
  normalisedPhone: string;
  email: string | null;
  reference: string | null;
  dvlaLicenceExpiry: Date | null;
  phvBadgeExpiry: Date | null;
  vehicleRegistration: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  notes: string | null;
}

const DRIVER_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;

export function validateDriverRow(
  row: Record<string, string>,
  line: number,
): RowOutcome<DriverRow> {
  const errors: RowError[] = [];
  const fail = (column: string | null, message: string) =>
    errors.push({ line, column, message });

  const name = tidy(row.name ?? '');
  if (name === '') fail('name', 'A driver needs a name');

  const phone = tidy(row.phone ?? '');
  if (phone === '') {
    fail('phone', 'A driver needs a phone number — it is what matches a re-import');
  }

  const email = tidy(row.email ?? '');
  if (email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail('email', `"${email}" is not a valid email address`);
  }

  const dvla = parseImportDate(row.dvlalicenceexpiry ?? '');
  if (!dvla.ok) fail('dvla_licence_expiry', dvla.message);

  const phv = parseImportDate(row.phvbadgeexpiry ?? '');
  if (!phv.ok) fail('phv_badge_expiry', phv.message);

  const status = enumValue(row.status ?? '', DRIVER_STATUSES, 'ACTIVE');
  if (!status.ok) fail('status', status.message);

  if (errors.length > 0) return { line, value: null, errors };

  const registration = tidy(row.vehicleregistration ?? '');

  return {
    line,
    errors: [],
    value: {
      name,
      phone,
      normalisedPhone: normalisePhone(phone),
      email: email === '' ? null : email.toLowerCase(),
      reference: tidy(row.reference ?? '') || null,
      dvlaLicenceExpiry: dvla.ok ? dvla.value : null,
      phvBadgeExpiry: phv.ok ? phv.value : null,
      vehicleRegistration: registration === '' ? null : registration,
      status: status.ok ? status.value : 'ACTIVE',
      notes: tidy(row.notes ?? '') || null,
    },
  };
}

// ----------------------------------------------------------------- vehicles

export interface VehicleRow {
  registration: string;
  normalisedRegistration: string;
  make: string;
  model: string;
  variant: string | null;
  colour: string | null;
  vehicleClass:
    | 'SALOON'
    | 'EXECUTIVE'
    | 'LUXURY'
    | 'MPV'
    | 'SUV'
    | 'ELECTRIC_EXECUTIVE';
  seats: number;
  ownership: 'OWNED' | 'FINANCED' | 'LEASED' | 'DRIVER_OWNED';
  motExpiry: Date | null;
  insuranceExpiry: Date | null;
  phvLicenceExpiry: Date | null;
  phvLicenceNumber: string | null;
  insurancePolicyNo: string | null;
  status: 'ACTIVE' | 'OFF_ROAD' | 'RETIRED';
}

const VEHICLE_CLASSES = [
  'SALOON',
  'EXECUTIVE',
  'LUXURY',
  'MPV',
  'SUV',
  'ELECTRIC_EXECUTIVE',
] as const;
const OWNERSHIPS = ['OWNED', 'FINANCED', 'LEASED', 'DRIVER_OWNED'] as const;
const VEHICLE_STATUSES = ['ACTIVE', 'OFF_ROAD', 'RETIRED'] as const;

export function validateVehicleRow(
  row: Record<string, string>,
  line: number,
): RowOutcome<VehicleRow> {
  const errors: RowError[] = [];
  const fail = (column: string | null, message: string) =>
    errors.push({ line, column, message });

  const registration = tidy(row.registration ?? '');
  if (registration === '') {
    fail('registration', 'A vehicle needs a registration — it is what matches a re-import');
  } else if (registration.length > 20) {
    fail('registration', `"${registration}" is too long to be a registration`);
  }

  const make = tidy(row.make ?? '');
  if (make === '') fail('make', 'A vehicle needs a make');

  const model = tidy(row.model ?? '');
  if (model === '') fail('model', 'A vehicle needs a model');

  const seatsRaw = tidy(row.seats ?? '');
  let seats = 4;
  if (seatsRaw !== '') {
    const parsed = Number(seatsRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
      fail('seats', `"${seatsRaw}" is not a seat count between 1 and 16`);
    } else {
      seats = parsed;
    }
  }

  const vehicleClass = enumValue(row.class ?? '', VEHICLE_CLASSES, 'EXECUTIVE');
  if (!vehicleClass.ok) fail('class', vehicleClass.message);

  const ownership = enumValue(row.ownership ?? '', OWNERSHIPS, 'DRIVER_OWNED');
  if (!ownership.ok) fail('ownership', ownership.message);

  const status = enumValue(row.status ?? '', VEHICLE_STATUSES, 'ACTIVE');
  if (!status.ok) fail('status', status.message);

  const mot = parseImportDate(row.motexpiry ?? '');
  if (!mot.ok) fail('mot_expiry', mot.message);

  const insurance = parseImportDate(row.insuranceexpiry ?? '');
  if (!insurance.ok) fail('insurance_expiry', insurance.message);

  const phv = parseImportDate(row.phvlicenceexpiry ?? '');
  if (!phv.ok) fail('phv_licence_expiry', phv.message);

  if (errors.length > 0) return { line, value: null, errors };

  return {
    line,
    errors: [],
    value: {
      registration: registration.toUpperCase(),
      normalisedRegistration: normaliseRegistration(registration),
      make,
      model,
      variant: tidy(row.variant ?? '') || null,
      colour: tidy(row.colour ?? '') || null,
      vehicleClass: vehicleClass.ok ? vehicleClass.value : 'EXECUTIVE',
      seats,
      ownership: ownership.ok ? ownership.value : 'DRIVER_OWNED',
      motExpiry: mot.ok ? mot.value : null,
      insuranceExpiry: insurance.ok ? insurance.value : null,
      phvLicenceExpiry: phv.ok ? phv.value : null,
      phvLicenceNumber: tidy(row.phvlicencenumber ?? '') || null,
      insurancePolicyNo: tidy(row.insurancepolicyno ?? '') || null,
      status: status.ok ? status.value : 'ACTIVE',
    },
  };
}

// ------------------------------------------------------------------ clients

export interface ClientRow {
  name: string;
  normalisedName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  vatNumber: string | null;
  paymentTermsDays: number;
  notes: string | null;
  /** What identifies this client on a re-import. */
  matchKey: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateClientRow(
  row: Record<string, string>,
  line: number,
): RowOutcome<ClientRow> {
  const errors: RowError[] = [];
  const fail = (column: string | null, message: string) =>
    errors.push({ line, column, message });

  const name = tidy(row.name ?? '');
  if (name === '') fail('name', 'A client needs a name');

  const contactEmail = tidy(row.contactemail ?? '');
  if (contactEmail !== '' && !EMAIL.test(contactEmail)) {
    fail('contact_email', `"${contactEmail}" is not a valid email address`);
  }

  const billingEmail = tidy(row.billingemail ?? '');
  if (billingEmail !== '' && !EMAIL.test(billingEmail)) {
    fail('billing_email', `"${billingEmail}" is not a valid email address`);
  }

  const termsRaw = tidy(row.paymenttermsdays ?? '');
  let paymentTermsDays = 14;
  if (termsRaw !== '') {
    const parsed = Number(termsRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
      fail('payment_terms_days', `"${termsRaw}" is not a number of days`);
    } else {
      paymentTermsDays = parsed;
    }
  }

  if (errors.length > 0) return { line, value: null, errors };

  const contactPhone = tidy(row.contactphone ?? '');
  // The same normalisation `lib/clients.ts` uses, so a client loaded from a
  // spreadsheet dedupes against one typed in by hand. Its own rules — case,
  // punctuation and honorifics — are what "the same client" means here.
  const normalisedName = normaliseName(name);

  return {
    line,
    errors: [],
    value: {
      name,
      normalisedName,
      contactEmail: contactEmail === '' ? null : contactEmail.toLowerCase(),
      contactPhone: contactPhone === '' ? null : contactPhone,
      billingEmail: billingEmail === '' ? null : billingEmail.toLowerCase(),
      billingAddress: tidy(row.billingaddress ?? '') || null,
      vatNumber: tidy(row.vatnumber ?? '') || null,
      paymentTermsDays,
      notes: tidy(row.notes ?? '') || null,
      // Name alone would merge two different people called John Smith. Name
      // plus a contact detail is what the spec asks for; a client with
      // neither falls back to the name, which is all there is to go on.
      matchKey:
        contactEmail !== ''
          ? `${normalisedName}|${contactEmail.toLowerCase()}`
          : contactPhone !== ''
            ? `${normalisedName}|${normalisePhone(contactPhone)}`
            : normalisedName,
    },
  };
}

/**
 * Rows that duplicate an earlier row in the same file.
 *
 * Reported rather than silently collapsed: two lines with the same
 * registration usually means somebody pasted a block twice, and the second
 * one quietly overwriting the first is how the wrong data wins.
 */
export function findDuplicatesInFile<T>(
  outcomes: Array<RowOutcome<T>>,
  keyOf: (value: T) => string,
): RowError[] {
  const seen = new Map<string, number>();
  const errors: RowError[] = [];

  for (const outcome of outcomes) {
    if (!outcome.value) continue;
    const key = keyOf(outcome.value);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({
        line: outcome.line,
        column: null,
        message: `The same record appears on line ${first}. Only the first is imported.`,
      });
    } else {
      seen.set(key, outcome.line);
    }
  }

  return errors;
}
