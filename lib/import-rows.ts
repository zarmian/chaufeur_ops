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

// --------------------------------------------------------------------- jobs

export interface JobRow {
  scheduledAt: Date;
  /** True when the file gave a date but no time, so the hour is a guess. */
  timeAssumed: boolean;
  jobType: 'AS_DIRECTED' | 'TRANSFER' | 'AIRPORT_TRANSFER';
  status: 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  pickupText: string;
  dropoffText: string;
  clientName: string | null;
  accountName: string | null;
  driverPhone: string | null;
  normalisedDriverPhone: string | null;
  driverName: string | null;
  vehicleRegistration: string | null;
  clientPricePence: number | null;
  driverPricePence: number | null;
  zeroValueReason: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  legacyReference: string | null;
  notes: string | null;
  /** What makes two rows the same job — see `ENTITY_DEFS.jobs.naturalKey`. */
  matchKey: string;
}

const JOB_TYPES = ['AS_DIRECTED', 'TRANSFER', 'AIRPORT_TRANSFER'] as const;
/**
 * Only the terminal states.
 *
 * A backfill describes work that finished. Importing a job as PENDING would
 * put historical work into today's dispatch queue, which is the one outcome
 * nobody wants from loading last year's spreadsheet.
 */
const JOB_STATUSES = ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;

/** "£165.50" and "165.5" both mean 16550. Never via a float multiply. */
export function parseMoneyPence(
  raw: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const value = raw.trim().replace(/[£\s,]/g, '');
  if (value === '') return { ok: true, value: null };

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    return { ok: false, message: `"${raw}" is not an amount. Write it as 165.50.` };
  }
  if (match[1] === '-') {
    return { ok: false, message: `"${raw}" is negative. A job price cannot be.` };
  }
  const minor = (match[3] ?? '').padEnd(2, '0');
  return { ok: true, value: Number(match[2]) * 100 + Number(minor) };
}

/** `14:30` on the job's date, read as UK local time. */
function applyTime(
  date: Date,
  raw: string,
): { ok: true; value: Date; assumed: boolean } | { ok: false; message: string } {
  const value = raw.trim();
  if (value === '') {
    // Midday rather than midnight: an unknown hour that lands at 00:00 reads
    // as "the night before" once it is shown in local time, and a job dated
    // the 3rd would appear on the 2nd for half the year.
    return { ok: true, value: new Date(date.getTime() + 12 * 60 * 60 * 1000), assumed: true };
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return { ok: false, message: `"${raw}" is not a time. Use 24-hour, like 14:30.` };
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return { ok: false, message: `"${raw}" is not a time of day` };
  }

  // The offset for that instant, so British Summer Time is handled rather
  // than assumed away — the rule this codebase exists to keep.
  const naive = new Date(date.getTime() + (hours * 60 + minutes) * 60 * 1000);
  const offset = ukOffsetMinutes(naive);
  return { ok: true, value: new Date(naive.getTime() - offset * 60 * 1000), assumed: false };
}

/**
 * Minutes Europe/London is ahead of UTC at `at`.
 *
 * Derived from the runtime's own zone data rather than a BST date table,
 * because the table is the thing that goes stale.
 */
function ukOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    timeZoneName: 'longOffset',
  }).formatToParts(at);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function validateJobRow(
  row: Record<string, string>,
  line: number,
): RowOutcome<JobRow> {
  const errors: RowError[] = [];
  const fail = (column: string | null, message: string) =>
    errors.push({ line, column, message });

  const parsedDate = parseImportDate(row.date ?? '');
  if (!parsedDate.ok) fail('date', parsedDate.message);
  else if (!parsedDate.value) fail('date', 'A job needs a date — it is when the work happened');

  const jobType = enumValue(row.jobtype ?? '', JOB_TYPES, 'TRANSFER');
  if (!jobType.ok) fail('job_type', jobType.message);

  const status = enumValue(row.status ?? '', JOB_STATUSES, 'COMPLETED');
  if (!status.ok) {
    fail(
      'status',
      `${status.message}. This file loads finished work only, so a job cannot arrive as pending.`,
    );
  }

  const pickupText = tidy(row.pickup ?? '');
  if (pickupText === '') fail('pickup', 'A job needs a pickup');
  const dropoffText = tidy(row.dropoff ?? '');
  if (dropoffText === '') fail('dropoff', 'A job needs a drop-off');

  const clientPrice = parseMoneyPence(row.clientprice ?? '');
  if (!clientPrice.ok) fail('client_price', clientPrice.message);
  const driverPrice = parseMoneyPence(row.driverprice ?? '');
  if (!driverPrice.ok) fail('driver_price', driverPrice.message);

  const zeroValueReason = tidy(row.zerovaluereason ?? '');
  // The guard from `lib/job-status.ts`, applied at the file rather than at
  // the transition. An import that quietly completed unpriced work would
  // reintroduce the exact defect this system was built to remove.
  if (
    status.ok &&
    status.value === 'COMPLETED' &&
    clientPrice.ok &&
    !clientPrice.value &&
    zeroValueReason === ''
  ) {
    fail(
      'client_price',
      'A completed job needs a client price, or a zero_value_reason saying why it has none',
    );
  }

  let scheduledAt: Date | null = null;
  let timeAssumed = false;
  if (parsedDate.ok && parsedDate.value) {
    const at = applyTime(parsedDate.value, row.time ?? '');
    if (!at.ok) fail('time', at.message);
    else {
      scheduledAt = at.value;
      timeAssumed = at.assumed;
    }
  }

  if (errors.length > 0 || !scheduledAt) {
    return { line, value: null, errors };
  }

  const driverPhone = tidy(row.driverphone ?? '');
  const registration = tidy(row.vehicleregistration ?? '');
  const clientName = tidy(row.clientname ?? '');
  const driverName = tidy(row.drivername ?? '');

  return {
    line,
    errors: [],
    value: {
      scheduledAt,
      timeAssumed,
      jobType: jobType.ok ? jobType.value : 'TRANSFER',
      status: status.ok ? status.value : 'COMPLETED',
      pickupText,
      dropoffText,
      clientName: clientName || null,
      accountName: tidy(row.accountname ?? '') || null,
      driverPhone: driverPhone || null,
      normalisedDriverPhone: driverPhone ? normalisePhone(driverPhone) : null,
      driverName: driverName || null,
      vehicleRegistration: registration ? normaliseRegistration(registration) : null,
      clientPricePence: clientPrice.ok ? clientPrice.value : null,
      driverPricePence: driverPrice.ok ? driverPrice.value : null,
      zeroValueReason: zeroValueReason || null,
      passengerName: tidy(row.passengername ?? '') || null,
      passengerPhone: tidy(row.passengerphone ?? '') || null,
      legacyReference: tidy(row.legacyreference ?? '') || null,
      notes: tidy(row.notes ?? '') || null,
      // The old references were reused across sheets, so they cannot identify
      // a job. What distinguishes two runs is when they happened, where they
      // went and who drove — and that is stable enough to re-import against.
      matchKey: [
        scheduledAt.toISOString().slice(0, 10),
        normaliseName(pickupText),
        normaliseName(dropoffText),
        driverPhone ? normalisePhone(driverPhone) : normaliseName(driverName),
        normaliseName(clientName),
      ].join('|'),
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
