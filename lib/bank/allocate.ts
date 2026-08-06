import { sumPence } from '../money';

/**
 * Spreading a payment across outstanding invoices.
 *
 * Oldest first, until the money runs out. The last invoice a payment partly
 * covers is left part-paid for the remainder; anything after it is untouched.
 *
 * Oldest-first rather than largest-first or exact-match-first, because that is
 * what an accountant does and what a client assumes: a payment covers the
 * oldest debt. An exact-match heuristic would look clever and occasionally
 * settle May's invoice while leaving March's outstanding, which is a
 * conversation nobody wants to have.
 *
 * Pure, so the arithmetic can be tested without a database. Nothing here
 * writes anything — it produces a *proposal*, which somebody confirms.
 */

export interface AllocatableInvoice {
  id: string;
  number: string;
  issueDate: Date;
  dueDate: Date;
  grossPence: number;
  paidPence: number;
  status: string;
}

export interface ProposedAllocation {
  invoiceId: string;
  number: string;
  amountPence: number;
  /** What the invoice's status would become. */
  becomes: 'PAID' | 'PART_PAID';
  outstandingBeforePence: number;
  outstandingAfterPence: number;
}

export interface AllocationProposal {
  allocations: ProposedAllocation[];
  allocatedPence: number;
  /** Money with no invoice left to settle. Recorded, never dropped. */
  unallocatedPence: number;
  /** Invoices deliberately skipped, and why. */
  skipped: Array<{ number: string; reason: string }>;
}

/**
 * Which invoices a credit should clear.
 *
 * A draft is never allocated to: it has not been sent, so nobody has been
 * asked to pay it, and marking it paid would leave an invoice the client has
 * never seen sitting in the ledger as settled.
 */
export function proposeAllocation(
  amountPence: number,
  invoices: AllocatableInvoice[],
): AllocationProposal {
  const allocations: ProposedAllocation[] = [];
  const skipped: AllocationProposal['skipped'] = [];

  if (amountPence <= 0) {
    return {
      allocations: [],
      allocatedPence: 0,
      unallocatedPence: 0,
      skipped: [],
    };
  }

  const payable = [...invoices]
    .filter((invoice) => {
      if (invoice.status === 'DRAFT') {
        skipped.push({
          number: invoice.number,
          reason: 'Still a draft — nobody has been asked to pay it',
        });
        return false;
      }
      if (invoice.status === 'CANCELLED') {
        skipped.push({ number: invoice.number, reason: 'Cancelled' });
        return false;
      }
      if (outstandingOf(invoice) <= 0) {
        skipped.push({ number: invoice.number, reason: 'Already settled' });
        return false;
      }
      return true;
    })
    // Oldest first, by issue date. The number breaks a tie, so two invoices
    // raised the same day settle in the order they were numbered rather than
    // in whatever order the database returned them.
    .sort(
      (a, b) =>
        a.issueDate.getTime() - b.issueDate.getTime() ||
        a.number.localeCompare(b.number),
    );

  let remaining = amountPence;

  for (const invoice of payable) {
    if (remaining <= 0) break;

    const outstanding = outstandingOf(invoice);
    const applied = Math.min(remaining, outstanding);

    allocations.push({
      invoiceId: invoice.id,
      number: invoice.number,
      amountPence: applied,
      becomes: applied >= outstanding ? 'PAID' : 'PART_PAID',
      outstandingBeforePence: outstanding,
      outstandingAfterPence: outstanding - applied,
    });

    remaining -= applied;
  }

  return {
    allocations,
    allocatedPence: sumPence(...allocations.map((a) => a.amountPence)),
    // Not forced onto an invoice and not silently dropped: a client who
    // overpays has a balance, and the next invoice should draw on it.
    unallocatedPence: remaining,
    skipped,
  };
}

function outstandingOf(invoice: {
  grossPence: number;
  paidPence: number;
}): number {
  return Math.max(0, invoice.grossPence - invoice.paidPence);
}

/**
 * Matching a debit to a driver payout.
 *
 * On the amount alone, and only when exactly one approved payout matches.
 * Two payouts of £1,240 in the same week is entirely normal — two drivers on
 * similar work — and picking either would mark the wrong one paid. Ambiguity
 * is reported so a person chooses.
 */
export interface MatchablePayout {
  id: string;
  driverName: string;
  totalPence: number;
  periodStart: Date;
  periodEnd: Date;
  status: string;
}

export type PayoutMatch =
  | { kind: 'one'; payout: MatchablePayout }
  | { kind: 'several'; candidates: MatchablePayout[] }
  | { kind: 'none'; reason: string };

export function matchPayout(
  amountPence: number,
  payouts: MatchablePayout[],
): PayoutMatch {
  // A payout is money out, so the statement line is negative.
  const wanted = Math.abs(amountPence);

  const candidates = payouts.filter(
    (payout) => payout.status === 'APPROVED' && payout.totalPence === wanted,
  );

  if (candidates.length === 1) return { kind: 'one', payout: candidates[0]! };
  if (candidates.length > 1) return { kind: 'several', candidates };

  return {
    kind: 'none',
    reason:
      payouts.some((payout) => payout.status === 'APPROVED')
        ? 'No approved payout for that exact amount'
        : 'No approved payouts waiting to be paid',
  };
}

/**
 * What is left unreconciled.
 *
 * The one figure that tells an operator whether the books are straight:
 * money that moved through the bank and that no invoice, payout or cost
 * accounts for.
 */
export function unreconciledPence(
  transactions: Array<{
    amountPence: number;
    allocatedPence: number;
    kind: string;
  }>,
): { inPence: number; outPence: number; totalPence: number } {
  let inPence = 0;
  let outPence = 0;

  for (const txn of transactions) {
    // A transfer between the operator's own accounts is neither income nor
    // cost. Counting it would double every figure on the reports.
    if (txn.kind === 'TRANSFER') continue;

    const unaccounted = Math.abs(txn.amountPence) - txn.allocatedPence;
    if (unaccounted <= 0) continue;

    if (txn.amountPence > 0) inPence += unaccounted;
    else outPence += unaccounted;
  }

  return { inPence, outPence, totalPence: inPence + outPence };
}
