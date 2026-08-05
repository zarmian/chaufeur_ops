import { describe, expect, it } from 'vitest';
import {
  ageInvoices,
  canEdit,
  creditNoteLines,
  daysOverdue,
  formatInvoiceNumber,
  invoiceTotals,
  isIssued,
  outstandingPence,
  parseInvoiceNumber,
  statusFor,
} from './invoices';

/**
 * Invoice arithmetic and the rules about what may still be changed.
 *
 * Two things here are worth being exact about. VAT computed per line and
 * summed drifts from VAT computed on the total, and an invoice that does not
 * agree with itself when somebody adds up the column is one that gets
 * queried. And a sent invoice is a document somebody else is holding —
 * editing it means two copies disagree with no indication which is right.
 */

const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('invoiceTotals', () => {
  it('splits net, VAT and gross at the configured rate', () => {
    const totals = invoiceTotals([10000, 5000], 20);
    expect(totals.netPence).toBe(15000);
    expect(totals.vatPence).toBe(3000);
    expect(totals.grossPence).toBe(18000);
  });

  it('computes VAT on the total, not per line', () => {
    // Twenty lines of £10.99 round to £2.20 of VAT each — £44.00 — where the
    // correct figure on £219.80 is £43.96. Either is defensible to HMRC; only
    // one agrees with the invoice when somebody adds the column up.
    const lines = Array.from({ length: 20 }, () => 1099);
    const totals = invoiceTotals(lines, 20);

    expect(totals.netPence).toBe(21980);
    expect(totals.vatPence).toBe(4396);
    expect(totals.grossPence).toBe(26376);
  });

  it('handles a zero rate without inventing VAT', () => {
    const totals = invoiceTotals([10000], 0);
    expect(totals.vatPence).toBe(0);
    expect(totals.grossPence).toBe(10000);
  });

  it('handles a fractional rate', () => {
    const totals = invoiceTotals([10000], 8.875);
    expect(totals.vatPence).toBe(888);
  });

  it('totals an empty invoice at nothing', () => {
    expect(invoiceTotals([], 20)).toEqual({
      netPence: 0,
      vatPence: 0,
      grossPence: 0,
    });
  });

  it('handles a credit note, where every line is negative', () => {
    const totals = invoiceTotals([-10000, -5000], 20);
    expect(totals.netPence).toBe(-15000);
    expect(totals.vatPence).toBe(-3000);
    expect(totals.grossPence).toBe(-18000);
  });
});

describe('outstandingPence', () => {
  it('is what is left to pay', () => {
    expect(outstandingPence({ grossPence: 18000, paidPence: 5000 })).toBe(13000);
  });

  it('is never negative — an overpayment is not a debt', () => {
    expect(outstandingPence({ grossPence: 18000, paidPence: 20000 })).toBe(0);
  });
});

describe('statusFor', () => {
  const base = { grossPence: 18000, paidPence: 0, dueDate: d('2026-07-01') };
  const before = d('2026-06-20');
  const after = d('2026-07-20');

  it('leaves a draft alone', () => {
    // A decision, not a consequence.
    expect(statusFor({ ...base, status: 'DRAFT' }, after)).toBe('DRAFT');
  });

  it('leaves a cancelled invoice alone', () => {
    expect(statusFor({ ...base, status: 'CANCELLED', paidPence: 18000 }, after)).toBe(
      'CANCELLED',
    );
  });

  it('is paid once the full amount is in', () => {
    expect(
      statusFor({ ...base, status: 'SENT', paidPence: 18000 }, after),
    ).toBe('PAID');
  });

  it('stays paid even past the due date', () => {
    expect(
      statusFor({ ...base, status: 'OVERDUE', paidPence: 18000 }, after),
    ).toBe('PAID');
  });

  it('is overdue rather than part-paid when late', () => {
    // A half-paid invoice three weeks late is a chasing problem, and calling
    // it PART_PAID hides that.
    expect(
      statusFor({ ...base, status: 'SENT', paidPence: 9000 }, after),
    ).toBe('OVERDUE');
  });

  it('is part-paid when something is in and it is not yet due', () => {
    expect(
      statusFor({ ...base, status: 'SENT', paidPence: 9000 }, before),
    ).toBe('PART_PAID');
  });

  it('is sent when nothing is in and it is not yet due', () => {
    expect(statusFor({ ...base, status: 'SENT' }, before)).toBe('SENT');
  });
});

describe('canEdit', () => {
  it('allows a draft', () => {
    expect(canEdit({ status: 'DRAFT' }).ok).toBe(true);
  });

  it('refuses anything that has been sent, and names the remedy', () => {
    // "Locked" on its own leaves somebody with a wrong invoice and no idea
    // what to do about it.
    for (const status of ['SENT', 'PART_PAID', 'PAID', 'OVERDUE'] as const) {
      const refusal = canEdit({ status });
      expect(refusal.ok, status).toBe(false);
      if (!refusal.ok) {
        expect(refusal.code).toBe('INVOICE_LOCKED');
        expect(refusal.message).toMatch(/credit note/);
      }
    }
  });

  it('refuses a cancelled invoice separately', () => {
    const refusal = canEdit({ status: 'CANCELLED' });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.code).toBe('INVOICE_CANCELLED');
  });

  it('agrees with isIssued', () => {
    expect(isIssued('DRAFT')).toBe(false);
    expect(isIssued('CANCELLED')).toBe(false);
    expect(isIssued('SENT')).toBe(true);
  });
});

describe('invoice numbers', () => {
  it('formats as prefix, year and a padded sequence', () => {
    expect(formatInvoiceNumber('INV', 2026, 1)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber('ACME', 2026, 1234)).toBe('ACME-2026-1234');
  });

  it('does not truncate past four digits', () => {
    // A busy year is not a reason to start reusing numbers.
    expect(formatInvoiceNumber('INV', 2026, 12345)).toBe('INV-2026-12345');
  });

  it('round-trips', () => {
    const parsed = parseInvoiceNumber('INV-2026-0042', 'INV');
    expect(parsed).toEqual({ year: 2026, sequence: 42 });
  });

  it('ignores a number from another series', () => {
    expect(parseInvoiceNumber('CRN-2026-0042', 'INV')).toBeNull();
    expect(parseInvoiceNumber('nonsense', 'INV')).toBeNull();
  });

  it('is not confused by a prefix carrying regex characters', () => {
    // The prefix is admin-configurable and reaches a regular expression.
    expect(parseInvoiceNumber('A.B-2026-0007', 'A.B')).toEqual({
      year: 2026,
      sequence: 7,
    });
    expect(parseInvoiceNumber('AXB-2026-0007', 'A.B')).toBeNull();
  });
});

describe('creditNoteLines', () => {
  it('negates every amount', () => {
    const lines = creditNoteLines([
      { description: 'Job JOB-000001', amountPence: 12500, jobId: 'job-1' },
      { description: 'Vehicle hire', amountPence: 28000, rentalId: 'rental-1' },
    ]);

    expect(lines[0]?.amountPence).toBe(-12500);
    expect(lines[1]?.amountPence).toBe(-28000);
  });

  it('keeps the link back to what was billed', () => {
    // Otherwise a credit note is untraceable free text and nothing reconciles.
    const lines = creditNoteLines([
      { description: 'Job', amountPence: 100, jobId: 'job-1' },
    ]);
    expect(lines[0]?.jobId).toBe('job-1');
    expect(lines[0]?.rentalId).toBeNull();
  });
});

describe('ageInvoices', () => {
  const now = d('2026-08-01');

  it('buckets by days past the due date, not days since issue', () => {
    // An invoice on 60-day terms is not overdue on day 31. Treating it as
    // such makes the aging report cry wolf until nobody reads it.
    const buckets = ageInvoices(
      [
        { grossPence: 10000, paidPence: 0, dueDate: d('2026-08-15') },
        { grossPence: 20000, paidPence: 0, dueDate: d('2026-07-20') },
        { grossPence: 30000, paidPence: 0, dueDate: d('2026-06-20') },
        { grossPence: 40000, paidPence: 0, dueDate: d('2026-05-20') },
        { grossPence: 50000, paidPence: 0, dueDate: d('2026-01-20') },
      ],
      now,
    );

    expect(buckets.current).toBe(10000);
    expect(buckets.days30).toBe(20000);
    expect(buckets.days60).toBe(30000);
    expect(buckets.days90).toBe(40000);
    expect(buckets.older).toBe(50000);
    expect(buckets.total).toBe(150000);
  });

  it('ages what is outstanding, not what was invoiced', () => {
    const buckets = ageInvoices(
      [{ grossPence: 20000, paidPence: 15000, dueDate: d('2026-07-20') }],
      now,
    );
    expect(buckets.days30).toBe(5000);
  });

  it('leaves a settled invoice out entirely', () => {
    const buckets = ageInvoices(
      [{ grossPence: 20000, paidPence: 20000, dueDate: d('2026-01-01') }],
      now,
    );
    expect(buckets.total).toBe(0);
  });

  it('totals nothing for an empty ledger', () => {
    expect(ageInvoices([], now).total).toBe(0);
  });
});

describe('daysOverdue', () => {
  it('is negative before the due date', () => {
    expect(daysOverdue(d('2026-08-15'), d('2026-08-01'))).toBeLessThan(0);
  });

  it('counts days once past', () => {
    expect(daysOverdue(d('2026-07-20'), d('2026-08-01'))).toBe(12);
  });
});
