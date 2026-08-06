import { createHash } from 'node:crypto';
import { parseCsv, parseCsvRows, normaliseHeader } from '../csv';

/**
 * Reading a bank statement CSV.
 *
 * Every UK bank exports a different shape, and the differences are not
 * cosmetic: some carry one signed amount, others separate debit and credit
 * columns, and at least one puts the debit in as a positive number that means
 * the opposite. Getting that wrong inverts the sign on every line, which
 * would credit invoices from money that left the account.
 *
 * Pure — no database, no clock beyond what is passed in — so every layout can
 * be tested from a fixture.
 */

export type BankLayout =
  | 'barclays'
  | 'hsbc'
  | 'lloyds'
  | 'natwest'
  | 'revolut'
  | 'starling'
  | 'custom';

export interface ParsedTransaction {
  occurredOn: Date;
  description: string;
  /** Signed pence. Negative is money out. */
  amountPence: number;
  bankRef: string | null;
  balancePence: number | null;
  fingerprint: string;
}

export interface StatementParse {
  layout: BankLayout;
  rows: ParsedTransaction[];
  /** Rows the parser could not read, with the reason and the line number. */
  problems: Array<{ line: number; reason: string }>;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/**
 * A layout is a set of column names, not a bank.
 *
 * Recognised by the headers present rather than by anything the operator
 * chooses — they should not have to know which of their bank's three export
 * formats they picked.
 */
interface LayoutSpec {
  name: BankLayout;
  /** All of these must be present for the layout to match. */
  requires: string[];
  date: string[];
  description: string[];
  /** One signed column… */
  amount?: string[];
  /** …or a debit/credit pair. */
  debit?: string[];
  credit?: string[];
  balance?: string[];
  reference?: string[];
}

const LAYOUTS: LayoutSpec[] = [
  {
    name: 'barclays',
    requires: ['date', 'amount', 'memo'],
    date: ['date'],
    description: ['memo', 'description'],
    amount: ['amount'],
    balance: ['balance'],
    reference: ['reference', 'number'],
  },
  {
    name: 'hsbc',
    requires: ['date', 'description', 'amount'],
    date: ['date'],
    description: ['description'],
    amount: ['amount'],
    balance: ['balance'],
  },
  {
    name: 'lloyds',
    requires: ['transactiondate', 'transactiondescription'],
    date: ['transactiondate'],
    description: ['transactiondescription'],
    debit: ['debitamount'],
    credit: ['creditamount'],
    balance: ['balance'],
    reference: ['transactiontype'],
  },
  {
    name: 'natwest',
    requires: ['date', 'description', 'value'],
    date: ['date'],
    description: ['description'],
    amount: ['value'],
    balance: ['balance'],
    reference: ['type'],
  },
  {
    name: 'revolut',
    requires: ['startedd', 'description', 'amount'],
    date: ['completedd', 'startedd'],
    description: ['description'],
    amount: ['amount'],
    balance: ['balance'],
    reference: ['type'],
  },
  {
    name: 'starling',
    requires: ['date', 'counterparty', 'amountgbp'],
    date: ['date'],
    description: ['counterparty', 'reference'],
    amount: ['amountgbp'],
    balance: ['balancegbp'],
    reference: ['reference'],
  },
];

/** The column mapping an operator supplies when nothing matched. */
export interface CustomMapping {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  balance?: string;
  reference?: string;
}

export function detectLayout(headers: string[]): LayoutSpec | null {
  const present = new Set(headers.map(normaliseHeader));

  // Revolut's headers collide with several others on `description`/`amount`,
  // so the most distinctive layout has to be tried first. Ordered by how
  // specific `requires` is, longest first.
  const ordered = [...LAYOUTS].sort(
    (a, b) => b.requires.length - a.requires.length,
  );

  return (
    ordered.find((layout) => layout.requires.every((key) => present.has(key))) ??
    null
  );
}

/**
 * Amount text to signed pence.
 *
 * Handles `1,234.56`, `£1,234.56`, `(12.50)` for a negative — accountants'
 * brackets, which at least two UK banks still emit — and a bare `-12.50`.
 * Returns null for anything it cannot read, because a zero here would be a
 * transaction that silently did nothing.
 */
export function parseAmountPence(input: string | undefined): number | null {
  if (input === undefined) return null;
  const text = input.trim();
  if (text === '') return null;

  const bracketed = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()£$€,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  // Rounded once, at the point it becomes money.
  const pence = Math.round(value * 100);
  return bracketed ? -Math.abs(pence) : pence;
}

/**
 * Statement dates are day-first.
 *
 * `03/04/2026` is 3 April, because that is what a UK bank means by it. ISO
 * `2026-04-03` is also accepted, since two of these exports use it.
 */
export function parseStatementDate(input: string | undefined): Date | null {
  if (!input) return null;
  const text = input.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(text);
  if (slash) {
    const year = Number(slash[3]);
    return utc(
      year < 100 ? 2000 + year : year,
      Number(slash[2]),
      Number(slash[1]),
    );
  }

  return null;
}

function utc(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February rather than rolling it into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * A stable identity for a transaction.
 *
 * The bank's own reference when there is one. Otherwise a hash of the date,
 * amount and description — which is what stops a second upload of an
 * overlapping period crediting every invoice twice.
 *
 * Deliberately not including the balance: two banks emit a running balance
 * that changes if the statement is re-exported after later activity, and a
 * fingerprint that moved would defeat the whole point.
 */
export function fingerprintOf(input: {
  occurredOn: Date;
  amountPence: number;
  description: string;
  bankRef: string | null;
}): string {
  if (input.bankRef && input.bankRef.trim() !== '') {
    return `ref:${input.bankRef.trim().toLowerCase()}`;
  }

  const material = [
    input.occurredOn.toISOString().slice(0, 10),
    String(input.amountPence),
    input.description.trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('|');

  return `h:${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/**
 * Parse a statement.
 *
 * A row the parser cannot read is reported rather than skipped silently: a
 * statement that imported 198 of 200 rows without saying so is one whose
 * reconciliation will never balance and nobody will know why.
 */
export function parseStatement(
  csv: string,
  mapping?: CustomMapping,
): StatementParse {
  const parsed = parseCsv(csv);
  const problems: StatementParse['problems'] = [];

  if (parsed.rows.length === 0) {
    return {
      layout: 'custom',
      rows: [],
      problems: [{ line: 0, reason: 'The file has no rows' }],
      periodStart: null,
      periodEnd: null,
    };
  }

  const headers = parsed.headers;
  // The header row as the operator's file actually spells it. Telling
  // somebody nothing matched "howmuch" when their column reads "How much"
  // sends them looking for a column that is not there.
  const rawHeaders = parseCsvRows(csv)[0] ?? headers;
  const detected = detectLayout(headers);

  const spec: LayoutSpec | null = detected
    ? detected
    : mapping
      ? {
          name: 'custom',
          requires: [],
          date: [normaliseHeader(mapping.date)],
          description: [normaliseHeader(mapping.description)],
          ...(mapping.amount ? { amount: [normaliseHeader(mapping.amount)] } : {}),
          ...(mapping.debit ? { debit: [normaliseHeader(mapping.debit)] } : {}),
          ...(mapping.credit ? { credit: [normaliseHeader(mapping.credit)] } : {}),
          ...(mapping.balance ? { balance: [normaliseHeader(mapping.balance)] } : {}),
          ...(mapping.reference
            ? { reference: [normaliseHeader(mapping.reference)] }
            : {}),
        }
      : null;

  if (!spec) {
    return {
      layout: 'custom',
      rows: [],
      problems: [
        {
          line: 0,
          reason: `Nothing matched these columns: ${rawHeaders.join(', ')}. Map them by hand and the mapping is remembered.`,
        },
      ],
      periodStart: null,
      periodEnd: null,
    };
  }

  const rows: ParsedTransaction[] = [];
  const seen = new Set<string>();

  parsed.rows.forEach((row, index) => {
    // +2: one for the header, one because humans count from one.
    const line = index + 2;

    const occurredOn = parseStatementDate(pick(row, spec.date));
    if (!occurredOn) {
      problems.push({ line, reason: 'No date the parser could read' });
      return;
    }

    const description = (pick(row, spec.description) ?? '').trim();
    const amountPence = amountFrom(row, spec);

    if (amountPence === null) {
      problems.push({ line, reason: 'No amount the parser could read' });
      return;
    }

    // A zero-value line is a statement artefact, not a transaction.
    if (amountPence === 0) return;

    const bankRef = (pick(row, spec.reference ?? []) ?? '').trim() || null;
    const fingerprint = fingerprintOf({
      occurredOn,
      amountPence,
      description,
      bankRef,
    });

    // Within one file, too: some exports repeat a row across page breaks.
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    rows.push({
      occurredOn,
      description,
      amountPence,
      bankRef,
      balancePence: parseAmountPence(pick(row, spec.balance ?? [])),
      fingerprint,
    });
  });

  const dates = rows.map((row) => row.occurredOn.getTime());

  return {
    layout: spec.name,
    rows,
    problems,
    periodStart: dates.length ? new Date(Math.min(...dates)) : null,
    periodEnd: dates.length ? new Date(Math.max(...dates)) : null,
  };
}

/**
 * One signed amount, or a debit/credit pair.
 *
 * A debit column holds a positive number meaning money out, so it is negated
 * here. Getting this backwards would credit invoices from money that left the
 * account, which is why the two shapes are handled explicitly rather than by
 * summing whatever columns happen to be present.
 */
function amountFrom(
  row: Record<string, string>,
  spec: LayoutSpec,
): number | null {
  if (spec.amount) {
    return parseAmountPence(pick(row, spec.amount));
  }

  const debit = parseAmountPence(pick(row, spec.debit ?? []));
  const credit = parseAmountPence(pick(row, spec.credit ?? []));

  if (debit !== null && debit !== 0) return -Math.abs(debit);
  if (credit !== null && credit !== 0) return Math.abs(credit);
  return null;
}

/** The first of these columns that carries anything. */
function pick(
  row: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}
