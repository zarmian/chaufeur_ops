import { roundPence, sumPence } from './money';

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
  | 'OVERDUE'
  | 'CANCELLED';

export interface InvoiceTotals {
  netPence: number;
  vatPence: number;
  grossPence: number;
}

/**
 * Net, VAT and gross from a set of line amounts.
 *
 * VAT is computed on the **total**, not per line and summed. Rounding each
 * line separately drifts: twenty lines of £10.99 at 20% round to £2.20 each,
 * £44.00 in total, where the correct figure on £219.80 is £43.96. HMRC would
 * accept either, but the invoice would not agree with itself when somebody
 * added the column up.
 */
export function invoiceTotals(
  linePence: number[],
  vatRatePct: number,
): InvoiceTotals {
  const netPence = sumPence(...linePence);
  const vatPence = roundPence((netPence * vatRatePct) / 100);

  return { netPence, vatPence, grossPence: netPence + vatPence };
}

/** What is still owed. Never negative — an overpayment is not a debt. */
export function outstandingPence(invoice: {
  grossPence: number;
  paidPence: number;
}): number {
  return Math.max(0, invoice.grossPence - invoice.paidPence);
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
  },
  now: Date = new Date(),
): InvoiceStatus {
  if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED') {
    return invoice.status;
  }

  if (invoice.paidPence >= invoice.grossPence && invoice.grossPence > 0) {
    return 'PAID';
  }

  // Overdue outranks part-paid: a half-paid invoice three weeks late is a
  // chasing problem, and calling it `PART_PAID` hides that.
  if (invoice.dueDate < now) return 'OVERDUE';

  if (invoice.paidPence > 0) return 'PART_PAID';

  return 'SENT';
}

/** Statuses at which the document has left the building. */
const ISSUED: InvoiceStatus[] = ['SENT', 'PART_PAID', 'PAID', 'OVERDUE'];

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
export function creditNoteLines(
  lines: Array<{ description: string; amountPence: number; jobId?: string | null; rentalId?: string | null }>,
): Array<{ description: string; amountPence: number; jobId: string | null; rentalId: string | null }> {
  return lines.map((line) => ({
    description: line.description,
    amountPence: -line.amountPence,
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
  invoices: Array<{ grossPence: number; paidPence: number; dueDate: Date }>,
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
