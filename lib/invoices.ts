import { invoiceTax, type TaxableLine, type VatTreatment } from './vat';

/**
 * Invoice arithmetic and the rules about what may still be changed.
 *
 * Pure, so the parts that must never be wrong can be tested exhaustively:
 * the VAT split, and the point past which an invoice stops being editable.
 *
 * The immutability rule is the one that matters. An invoice that has been
 * sent is a document somebody else is holding. Changing it means their copy
 * and yours disagree, and neither is marked as wrong — so a sent invoice is
 * corrected with a credit note, never by editing.
 */

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'PART_PAID'
  | 'PAID'
  | 'CREDITED'
  | 'OVERDUE'
  | 'CANCELLED';

export interface InvoiceTotals {
  netPence: number;
  vatPence: number;
  grossPence: number;
}

/**
 * Net, tax and gross from a set of lines.
 *
 * A thin wrapper over `invoiceTax`, kept because the invoice header stores
 * exactly these three numbers. The arithmetic — grouping by treatment, keeping
 * pass-through charges out of the base, backing tax out of an inclusive price
 * — lives in `lib/vat.ts` and is documented there.
 *
 * Bare numbers are accepted for the common case of "everything at the standard
 * rate, nothing passed through", which is what every line was before
 * treatments existed.
 */
export function invoiceTotals(
  lines: Array<TaxableLine | number>,
  vatRatePct: number,
): InvoiceTotals {
  const tax = invoiceTax(
    lines.map((line) =>
      typeof line === 'number'
        ? { amountPence: line, treatment: 'STANDARD' as const }
        : line,
    ),
    vatRatePct,
  );

  return {
    netPence: tax.netPence,
    vatPence: tax.taxPence,
    grossPence: tax.grossPence,
  };
}

export interface SettleableInvoice {
  grossPence: number;
  paidPence: number;
  /**
   * What credit notes against this invoice come to, as a positive number.
   *
   * Absent means "not loaded", not "none" — a caller that forgets it gets the
   * old answer, which is why every caller in this repository passes it.
   */
  creditedPence?: number;
}

/**
 * What is still owed.
 *
 * Never negative — an overpayment is not a debt, and flooring per invoice
 * before any sum is what stops one client's overpayment quietly offsetting
 * another's arrears.
 *
 * **Credit notes settle the invoice they credit.** Without that, a fully
 * credited invoice kept its whole balance: the ledger showed Outstanding
 * £2,005.20 against Invoiced £1,789.80 — more owed than was ever billed —
 * because the credit note netted out of the invoiced total but contributed
 * nothing to outstanding, while the invoice it cancelled kept its £338.40.
 * The invoice would then age into `OVERDUE` and be chased for money already
 * credited, which is a letter no client should ever receive.
 *
 * A credit note has negative gross and is not itself a debt, so it floors to
 * zero on its own account.
 */
export function outstandingPence(invoice: SettleableInvoice): number {
  return Math.max(
    0,
    invoice.grossPence - invoice.paidPence - (invoice.creditedPence ?? 0),
  );
}

/** What a credit note reverses, as a positive number. */
export function creditedTotalPence(
  creditNotes: Array<{ grossPence: number }>,
): number {
  // Credit notes carry negative gross, and callers want a positive figure.
  return creditNotes.reduce((sum, note) => sum - note.grossPence, 0);
}

/**
 * The status an invoice should be in, given what has been paid and the date.
 *
 * Derived rather than stored-and-updated, so a payment recorded at the wrong
 * time cannot leave an invoice reading `SENT` while fully paid. `DRAFT` and
 * `CANCELLED` are decisions rather than consequences, so they are left alone.
 */
export function statusFor(
  invoice: {
    status: InvoiceStatus;
    grossPence: number;
    paidPence: number;
    dueDate: Date;
    creditedPence?: number;
  },
  now: Date = new Date(),
): InvoiceStatus {
  if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED') {
    return invoice.status;
  }

  if (invoice.paidPence >= invoice.grossPence && invoice.grossPence > 0) {
    return 'PAID';
  }

  // Reversed rather than paid, and said so. Without this a fully credited
  // invoice aged into `OVERDUE` and was chased for money already given back;
  // calling it `PAID` would have stopped the chasing but left a ledger that
  // cannot be reconciled against a bank statement, because no money arrived.
  if (outstandingPence(invoice) === 0 && invoice.grossPence > 0) {
    return 'CREDITED';
  }

  // Overdue outranks part-paid: a half-paid invoice three weeks late is a
  // chasing problem, and calling it `PART_PAID` hides that.
  if (invoice.dueDate < now) return 'OVERDUE';

  if (invoice.paidPence > 0) return 'PART_PAID';

  return 'SENT';
}

/**
 * Statuses that owe nothing, so they are never chased and never counted as
 * debt. Named once because four separate `notIn` lists had already drifted
 * apart, and a credit note that appears in one of them but not another is
 * exactly how an invoice gets chased after it has been reversed.
 */
export const SETTLED: InvoiceStatus[] = ['PAID', 'CREDITED', 'CANCELLED', 'DRAFT'];

/** Statuses at which the document has left the building. */
const ISSUED: InvoiceStatus[] = ['SENT', 'PART_PAID', 'PAID', 'OVERDUE', 'CREDITED'];

export function isIssued(status: InvoiceStatus): boolean {
  return ISSUED.includes(status);
}

export type EditRefusal =
  | { ok: true }
  | { ok: false; code: 'INVOICE_LOCKED' | 'INVOICE_CANCELLED'; message: string };

/**
 * Whether an invoice may still be changed.
 *
 * Spec 4.3.10. The refusal names the remedy, because "locked" on its own
 * leaves somebody with a wrong invoice and no idea what to do about it.
 */
export function canEdit(invoice: { status: InvoiceStatus }): EditRefusal {
  if (invoice.status === 'CANCELLED') {
    return {
      ok: false,
      code: 'INVOICE_CANCELLED',
      message: 'This invoice was cancelled. Raise a new one instead.',
    };
  }

  if (isIssued(invoice.status)) {
    return {
      ok: false,
      code: 'INVOICE_LOCKED',
      message:
        'This invoice has been sent, so the recipient is holding a copy of it. Correct it with a credit note rather than editing — otherwise their copy and yours disagree and neither says which is right.',
    };
  }

  return { ok: true };
}

/**
 * The invoice number for a given year and sequence.
 *
 * `INV-2026-0001`. The year is part of the number rather than only the date,
 * because that is how people file them, and the sequence restarts each year.
 */
export function formatInvoiceNumber(
  prefix: string,
  year: number,
  sequence: number,
): string {
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}

/** Pull the sequence back out, ignoring anything that does not match. */
export function parseInvoiceNumber(
  number: string,
  prefix: string,
): { year: number; sequence: number } | null {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d{4})-(\\d+)$`);
  const match = pattern.exec(number.trim());
  if (!match) return null;

  return { year: Number(match[1]), sequence: Number(match[2]) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A credit note reverses an invoice, so every amount is negated.
 *
 * Not a partial: a credit note for part of an invoice is a separate decision
 * the operator makes by editing the lines afterwards, while it is still a
 * draft. What this guarantees is that the default is a complete reversal,
 * because a credit note that quietly credits less than the invoice is worse
 * than one that credits too much.
 */
export interface CreditableLine {
  description: string;
  amountPence: number;
  disbursementPence?: number | null;
  vatTreatment?: VatTreatment | null;
  quantity?: unknown;
  quantityUnit?: string | null;
  unitPricePence?: number | null;
  jobId?: string | null;
  rentalId?: string | null;
}

export function creditNoteLines(lines: CreditableLine[]): Array<{
  description: string;
  amountPence: number;
  disbursementPence: number;
  vatTreatment: VatTreatment;
  quantity: unknown;
  quantityUnit: string | null;
  unitPricePence: number | null;
  jobId: string | null;
  rentalId: string | null;
}> {
  return lines.map((line) => ({
    description: line.description,
    amountPence: -line.amountPence,
    // Negated with the amount, so the credited line's tax base is the mirror
    // of the original's. Leaving it positive would credit the fare in full
    // while still charging tax on a disbursement that no longer exists.
    disbursementPence: -(line.disbursementPence ?? 0),
    // The treatment travels with the line. A credit note that reverses an
    // exempt line at the standard rate hands back tax nobody ever paid.
    vatTreatment: line.vatTreatment ?? 'STANDARD',
    // Quantity and unit price are description, not money — a credit for one
    // trip is still one trip, and negating the count reads as nonsense.
    quantity: line.quantity ?? null,
    quantityUnit: line.quantityUnit ?? null,
    unitPricePence: line.unitPricePence ?? null,
    jobId: line.jobId ?? null,
    rentalId: line.rentalId ?? null,
  }));
}

export interface AgingBuckets {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  older: number;
  total: number;
}

export const AGING_LABELS: Array<{ key: keyof AgingBuckets; label: string }> = [
  { key: 'current', label: 'Not yet due' },
  { key: 'days30', label: '0–30 days' },
  { key: 'days60', label: '31–60 days' },
  { key: 'days90', label: '61–90 days' },
  { key: 'older', label: '90+ days' },
];

/**
 * Outstanding balances bucketed by how overdue they are.
 *
 * Buckets are by *days past the due date*, not days since issue — an invoice
 * on 60-day terms is not overdue on day 31, and treating it as such would
 * make the aging report cry wolf until nobody read it.
 */
export function ageInvoices(
  invoices: Array<SettleableInvoice & { dueDate: Date }>,
  now: Date = new Date(),
): AgingBuckets {
  const buckets: AgingBuckets = {
    current: 0,
    days30: 0,
    days60: 0,
    days90: 0,
    older: 0,
    total: 0,
  };

  for (const invoice of invoices) {
    const outstanding = outstandingPence(invoice);
    if (outstanding === 0) continue;

    const daysOverdue = Math.floor(
      (now.getTime() - invoice.dueDate.getTime()) / 86_400_000,
    );

    if (daysOverdue < 0) buckets.current += outstanding;
    else if (daysOverdue <= 30) buckets.days30 += outstanding;
    else if (daysOverdue <= 60) buckets.days60 += outstanding;
    else if (daysOverdue <= 90) buckets.days90 += outstanding;
    else buckets.older += outstanding;

    buckets.total += outstanding;
  }

  return buckets;
}

/** How many days past due, negative when it is not due yet. */
export function daysOverdue(dueDate: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
}
