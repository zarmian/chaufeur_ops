import { describe, expect, it } from 'vitest';
import {
  matchPayout,
  proposeAllocation,
  unreconciledPence,
  type AllocatableInvoice,
} from './allocate';

/**
 * Where a payment lands.
 *
 * The scenario the operator described: a client pays £1,000, the system
 * clears invoices oldest first until the money runs out, and the one it only
 * partly covers becomes part-paid.
 *
 * What has to be true beyond that is mostly about restraint. Money left over
 * is not forced onto an invoice. A draft is never settled. An ambiguous
 * payout match picks nothing rather than guessing. Each of those is a case
 * where doing something plausible would be worse than doing nothing.
 */

function invoice(
  overrides: Partial<AllocatableInvoice> & { number: string },
): AllocatableInvoice {
  return {
    id: `inv-${overrides.number}`,
    issueDate: new Date('2026-01-01T00:00:00Z'),
    dueDate: new Date('2026-01-15T00:00:00Z'),
    grossPence: 30_000,
    paidPence: 0,
    status: 'SENT',
    ...overrides,
  };
}

describe('proposeAllocation', () => {
  const march = new Date('2026-03-01T00:00:00Z');
  const april = new Date('2026-04-01T00:00:00Z');
  const may = new Date('2026-05-01T00:00:00Z');

  it('clears invoices oldest first until the money runs out', () => {
    // £1,000 against £300 + £300 + £600. The first two clear; the third is
    // left owing £200.
    const proposal = proposeAllocation(100_000, [
      invoice({ number: 'INV-3', issueDate: may, grossPence: 60_000 }),
      invoice({ number: 'INV-1', issueDate: march, grossPence: 30_000 }),
      invoice({ number: 'INV-2', issueDate: april, grossPence: 30_000 }),
    ]);

    expect(proposal.allocations.map((a) => a.number)).toEqual([
      'INV-1',
      'INV-2',
      'INV-3',
    ]);
    expect(proposal.allocations.map((a) => a.becomes)).toEqual([
      'PAID',
      'PAID',
      'PART_PAID',
    ]);
    expect(proposal.allocations[2]?.amountPence).toBe(40_000);
    expect(proposal.allocations[2]?.outstandingAfterPence).toBe(20_000);
    expect(proposal.allocatedPence).toBe(100_000);
    expect(proposal.unallocatedPence).toBe(0);
  });

  it('accounts for what has already been paid on an invoice', () => {
    const proposal = proposeAllocation(10_000, [
      invoice({ number: 'INV-1', grossPence: 30_000, paidPence: 25_000 }),
      invoice({ number: 'INV-2', grossPence: 30_000, issueDate: april }),
    ]);

    // £50 clears the first, £50 goes onto the second.
    expect(proposal.allocations[0]?.amountPence).toBe(5000);
    expect(proposal.allocations[0]?.becomes).toBe('PAID');
    expect(proposal.allocations[1]?.amountPence).toBe(5000);
    expect(proposal.allocations[1]?.becomes).toBe('PART_PAID');
  });

  it('keeps money over as unallocated rather than forcing it somewhere', () => {
    // A client who overpays has a balance. Squeezing it onto an invoice
    // would make that invoice read as overpaid, and dropping it would lose
    // money the client is entitled to.
    const proposal = proposeAllocation(50_000, [
      invoice({ number: 'INV-1', grossPence: 30_000 }),
    ]);

    expect(proposal.allocatedPence).toBe(30_000);
    expect(proposal.unallocatedPence).toBe(20_000);
  });

  it('never settles a draft', () => {
    // It has not been sent, so nobody has been asked to pay it. Marking it
    // paid would leave an invoice the client has never seen reading settled.
    const proposal = proposeAllocation(100_000, [
      invoice({ number: 'INV-DRAFT', status: 'DRAFT', issueDate: march }),
      invoice({ number: 'INV-SENT', status: 'SENT', issueDate: april }),
    ]);

    expect(proposal.allocations.map((a) => a.number)).toEqual(['INV-SENT']);
    expect(proposal.skipped[0]?.number).toBe('INV-DRAFT');
    expect(proposal.skipped[0]?.reason).toContain('draft');
  });

  it('skips cancelled and already-settled invoices, and says so', () => {
    const proposal = proposeAllocation(10_000, [
      invoice({ number: 'INV-C', status: 'CANCELLED' }),
      invoice({ number: 'INV-P', grossPence: 30_000, paidPence: 30_000 }),
    ]);

    expect(proposal.allocations).toEqual([]);
    expect(proposal.unallocatedPence).toBe(10_000);
    expect(proposal.skipped.map((s) => s.number).sort()).toEqual([
      'INV-C',
      'INV-P',
    ]);
  });

  it('settles two invoices raised the same day in number order', () => {
    // Otherwise the order depends on whatever the database returned, and the
    // same statement would allocate differently on a second run.
    const proposal = proposeAllocation(30_000, [
      invoice({ number: 'INV-2026-0002', grossPence: 30_000 }),
      invoice({ number: 'INV-2026-0001', grossPence: 30_000 }),
    ]);

    expect(proposal.allocations[0]?.number).toBe('INV-2026-0001');
  });

  it('does nothing with nothing, and nothing with a debit', () => {
    expect(proposeAllocation(0, [invoice({ number: 'INV-1' })]).allocations).toEqual(
      [],
    );
    expect(
      proposeAllocation(-5000, [invoice({ number: 'INV-1' })]).allocations,
    ).toEqual([]);
  });

  it('handles a payment that exactly clears everything', () => {
    const proposal = proposeAllocation(60_000, [
      invoice({ number: 'INV-1', grossPence: 30_000, issueDate: march }),
      invoice({ number: 'INV-2', grossPence: 30_000, issueDate: april }),
    ]);

    expect(proposal.allocations.every((a) => a.becomes === 'PAID')).toBe(true);
    expect(proposal.unallocatedPence).toBe(0);
  });
});

describe('matchPayout', () => {
  const base = {
    periodStart: new Date('2026-04-01T00:00:00Z'),
    periodEnd: new Date('2026-04-07T00:00:00Z'),
    status: 'APPROVED',
  };

  it('matches one approved payout of the same amount', () => {
    const match = matchPayout(-124_000, [
      { ...base, id: 'p1', driverName: 'A', totalPence: 124_000 },
      { ...base, id: 'p2', driverName: 'B', totalPence: 98_000 },
    ]);

    expect(match.kind).toBe('one');
    if (match.kind === 'one') expect(match.payout.id).toBe('p1');
  });

  it('refuses to choose between two payouts of the same amount', () => {
    // Two drivers on similar work is entirely normal, and picking either
    // would mark the wrong one paid.
    const match = matchPayout(-124_000, [
      { ...base, id: 'p1', driverName: 'A', totalPence: 124_000 },
      { ...base, id: 'p2', driverName: 'B', totalPence: 124_000 },
    ]);

    expect(match.kind).toBe('several');
    if (match.kind === 'several') expect(match.candidates).toHaveLength(2);
  });

  it('ignores payouts that are not approved', () => {
    const match = matchPayout(-124_000, [
      { ...base, id: 'p1', driverName: 'A', totalPence: 124_000, status: 'DRAFT' },
    ]);

    expect(match.kind).toBe('none');
    if (match.kind === 'none') expect(match.reason).toContain('No approved');
  });

  it('says which kind of nothing it found', () => {
    const approved = matchPayout(-500, [
      { ...base, id: 'p1', driverName: 'A', totalPence: 124_000 },
    ]);
    expect(approved.kind).toBe('none');
    if (approved.kind === 'none') {
      expect(approved.reason).toContain('exact amount');
    }
  });
});

describe('unreconciledPence', () => {
  it('counts what no invoice, payout or cost accounts for', () => {
    const total = unreconciledPence([
      { amountPence: 100_000, allocatedPence: 100_000, kind: 'CLIENT_PAYMENT' },
      { amountPence: 50_000, allocatedPence: 30_000, kind: 'CLIENT_PAYMENT' },
      { amountPence: -8950, allocatedPence: 0, kind: 'FUEL' },
    ]);

    expect(total.inPence).toBe(20_000);
    expect(total.outPence).toBe(8950);
    expect(total.totalPence).toBe(28_950);
  });

  it('leaves own transfers out entirely', () => {
    // Neither income nor cost. Counting them would double every figure on
    // the reports.
    const total = unreconciledPence([
      { amountPence: 500_000, allocatedPence: 0, kind: 'TRANSFER' },
      { amountPence: -500_000, allocatedPence: 0, kind: 'TRANSFER' },
    ]);

    expect(total.totalPence).toBe(0);
  });

  it('is zero when everything is accounted for', () => {
    expect(
      unreconciledPence([
        { amountPence: 100_000, allocatedPence: 100_000, kind: 'CLIENT_PAYMENT' },
      ]).totalPence,
    ).toBe(0);
  });
});
