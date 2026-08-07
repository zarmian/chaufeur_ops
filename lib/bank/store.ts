import { Prisma } from '@prisma/client';
import { recordAudit, withAudit, type AuditContext } from '../audit';
import { creditedPenceFor } from '../invoice-store';
import { statusFor, type InvoiceStatus } from '../invoices';
import { getLocaleConfig } from '../locale-store';
import { formatMoney } from '../money';
import { prisma } from '../prisma';
import {
  matchPayout,
  proposeAllocation,
  type AllocationProposal,
  type MatchablePayout,
  type PayoutMatch,
} from './allocate';
import {
  classify,
  matchPayer,
  SEED_RULES,
  type BankTxnKind,
  type ClassifyRule,
  type Payer,
} from './classify';
import { parseStatement, type CustomMapping, type StatementParse } from './statement';

/**
 * Importing a statement and acting on it.
 *
 * The arithmetic is in `allocate.ts` and the matching is in `classify.ts`,
 * both pure. What lives here is everything that touches the database, and the
 * discipline that goes with it: a proposal is computed and shown, nothing is
 * written until somebody confirms, and what is written can be undone.
 *
 * The undo is not a nicety. Allocation marks invoices paid, and an operator
 * who cannot reverse a bad import will not trust a good one.
 */

export type BankResult<T = unknown> =
  | ({ ok: true; id: string } & T)
  | { ok: false; code: string; message: string };

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

export async function activeRules(): Promise<ClassifyRule[]> {
  const rules = await prisma.bankRule.findMany({
    where: { active: true },
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
  });

  return rules.map((rule) => ({
    id: rule.id,
    phrase: rule.phrase,
    kind: rule.kind as BankTxnKind,
    priority: rule.priority,
    active: rule.active,
    clientId: rule.clientId,
    accountId: rule.accountId,
    driverId: rule.driverId,
    vehicleId: rule.vehicleId,
  }));
}

export async function listRules() {
  return prisma.bankRule.findMany({
    orderBy: [{ active: 'desc' }, { priority: 'desc' }, { phrase: 'asc' }],
  });
}

export interface RuleInput {
  phrase: string;
  kind: BankTxnKind;
  priority?: number;
  active?: boolean;
  clientId?: string | null;
  accountId?: string | null;
  driverId?: string | null;
  vehicleId?: string | null;
}

export async function saveRule(
  id: string | null,
  input: RuleInput,
): Promise<BankResult> {
  const phrase = input.phrase.trim();
  if (phrase === '') {
    return {
      ok: false,
      code: 'BLANK_PHRASE',
      message: 'A rule with no phrase would match every transaction.',
    };
  }
  if (input.kind === 'UNCLASSIFIED') {
    return {
      ok: false,
      code: 'NOT_A_CLASSIFICATION',
      message: 'A rule has to say what something is.',
    };
  }

  const data = {
    phrase,
    kind: input.kind,
    priority: input.priority ?? 0,
    active: input.active ?? true,
    clientId: input.clientId ?? null,
    accountId: input.accountId ?? null,
    driverId: input.driverId ?? null,
    vehicleId: input.vehicleId ?? null,
  };

  const rule = id
    ? await prisma.bankRule.update({ where: { id }, data })
    : await prisma.bankRule.create({ data });

  return { ok: true, id: rule.id };
}

export async function deleteRule(id: string): Promise<BankResult> {
  await prisma.bankRule.delete({ where: { id } });
  return { ok: true, id };
}

/**
 * The starting rules, written once.
 *
 * Idempotent on the phrase, so running it again after the operator has
 * deleted a rule they did not want does not resurrect it — a deleted rule is
 * soft-deleted and still counts as present.
 */
export async function seedRules(): Promise<number> {
  const existing = await prisma.bankRule.findMany({
    select: { phrase: true },
  });
  const seen = new Set(existing.map((rule) => rule.phrase.toLowerCase()));

  const missing = SEED_RULES.filter(
    (rule) => !seen.has(rule.phrase.toLowerCase()),
  );
  if (missing.length === 0) return 0;

  await prisma.bankRule.createMany({ data: missing });
  return missing.length;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export interface ImportPreview {
  layout: string;
  parse: StatementParse;
  /** Rows already in the database under the same fingerprint. */
  duplicates: number;
  /** Rows that would be written. */
  fresh: number;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/**
 * What an import would do, without doing it.
 *
 * Spec 4.8.1.6: the operator sees how many rows were read, how many have been
 * seen before and how many the parser could not make sense of, before
 * anything is written.
 */
export async function previewImport(
  csv: string,
  mapping?: CustomMapping,
): Promise<ImportPreview> {
  const parse = parseStatement(csv, mapping);

  const known = await prisma.bankTransaction.findMany({
    where: { fingerprint: { in: parse.rows.map((row) => row.fingerprint) } },
    select: { fingerprint: true },
  });
  const seen = new Set(known.map((row) => row.fingerprint));
  const duplicates = parse.rows.filter((row) => seen.has(row.fingerprint)).length;

  return {
    layout: parse.layout,
    parse,
    duplicates,
    fresh: parse.rows.length - duplicates,
    periodStart: parse.periodStart,
    periodEnd: parse.periodEnd,
  };
}

export interface ImportOutcome {
  statementId: string;
  imported: number;
  duplicates: number;
  problems: number;
}

/**
 * Write a statement.
 *
 * Rows already present are counted and skipped rather than updated: a
 * transaction that has been classified and allocated must not be reset
 * because somebody re-uploaded an overlapping period, which is exactly what
 * an operator does when they are not sure whether last week's import worked.
 */
export async function importStatement(
  input: { filename: string; csv: string; mapping?: CustomMapping },
  context: AuditContext = {},
): Promise<BankResult<{ outcome: ImportOutcome }>> {
  const parse = parseStatement(input.csv, input.mapping);

  if (parse.rows.length === 0) {
    return {
      ok: false,
      code: 'NOTHING_READ',
      message:
        parse.problems[0]?.reason ??
        'Nothing in that file looked like a transaction.',
    };
  }

  // Spec 4.8.2.5. On the first import rather than at install, because an
  // existing deployment upgrading into this feature never re-runs the wizard
  // and would otherwise start with no rules at all.
  if ((await prisma.bankRule.count()) === 0) await seedRules();

  const rules = await activeRules();
  const payers = await allPayers();

  const known = await prisma.bankTransaction.findMany({
    where: { fingerprint: { in: parse.rows.map((row) => row.fingerprint) } },
    select: { fingerprint: true },
  });
  const seen = new Set(known.map((row) => row.fingerprint));
  const fresh = parse.rows.filter((row) => !seen.has(row.fingerprint));

  // A year-end statement is thousands of rows, and Prisma's default
  // interactive-transaction timeout is five seconds. A partially-imported
  // statement is not a thing this can produce — either all of it lands or
  // none of it does — so the ceiling is raised rather than the transaction
  // broken up.
  const statement = await prisma.$transaction(async (tx) => {
    const created = await tx.bankStatement.create({
      data: {
        filename: input.filename,
        layout: parse.layout,
        periodStart: parse.periodStart,
        periodEnd: parse.periodEnd,
        rowCount: parse.rows.length,
        importedCount: fresh.length,
        duplicateCount: parse.rows.length - fresh.length,
        uploadedById: context.userId ?? null,
      },
    });

    const hits = new Map<string, number>();

    for (const row of fresh) {
      const decision = classify(row, rules);
      const attributed = attribute(decision, row, payers);
      if (decision.ruleId) {
        hits.set(decision.ruleId, (hits.get(decision.ruleId) ?? 0) + 1);
      }

      await tx.bankTransaction.create({
        data: {
          statementId: created.id,
          occurredOn: row.occurredOn,
          description: row.description,
          amountPence: row.amountPence,
          bankRef: row.bankRef,
          balancePence: row.balancePence,
          fingerprint: row.fingerprint,
          kind: attributed.kind,
          matchedRuleId: decision.ruleId,
          clientId: attributed.clientId,
          accountId: attributed.accountId,
          driverId: attributed.driverId,
          vehicleId: attributed.vehicleId,
        },
      });
    }

    // Rule hit counts, so dead rules can be found and pruned.
    for (const [ruleId, count] of hits) {
      await tx.bankRule.update({
        where: { id: ruleId },
        data: { hitCount: { increment: count } },
      });
    }

    return created;
  }, { maxWait: 15_000, timeout: 120_000 });

  return {
    ok: true,
    id: statement.id,
    outcome: {
      statementId: statement.id,
      imported: fresh.length,
      duplicates: parse.rows.length - fresh.length,
      problems: parse.problems.length,
    },
  };
}

/**
 * Who a credit is from, when no rule pinned it.
 *
 * A rule that names a client wins outright — somebody said so. Otherwise the
 * payer's name is looked for in the description, and only an unambiguous
 * match is used. Everything else stays unattributed and is listed for manual
 * allocation, which is spec 4.8.3.7: better an operator spends a minute than
 * that a payment lands on the wrong client's oldest invoice.
 */
function attribute(
  decision: ReturnType<typeof classify>,
  row: { description: string; amountPence: number },
  payers: Payer[],
): {
  kind: BankTxnKind;
  clientId: string | null;
  accountId: string | null;
  driverId: string | null;
  vehicleId: string | null;
} {
  const base = {
    kind: decision.kind,
    clientId: decision.clientId,
    accountId: decision.accountId,
    driverId: decision.driverId,
    vehicleId: decision.vehicleId,
  };

  if (base.clientId || base.accountId) return base;
  // Only worth looking on money coming in: a debit's counterparty is a
  // supplier, and suppliers are not in this list.
  if (row.amountPence <= 0) return base;

  const match = matchPayer(row.description, payers);
  if (match.kind !== 'one') return base;

  return {
    ...base,
    // A recognised payer makes an unclassified credit a client payment. The
    // name in the reference is the operator's own client; there is nothing
    // else it could be.
    kind: base.kind === 'UNCLASSIFIED' ? 'CLIENT_PAYMENT' : base.kind,
    clientId: match.payer.kind === 'client' ? match.payer.id : null,
    accountId: match.payer.kind === 'account' ? match.payer.id : null,
  };
}

async function allPayers(): Promise<Payer[]> {
  const [clients, accounts] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true } }),
    prisma.account.findMany({ select: { id: true, name: true } }),
  ]);

  return [
    ...clients.map((c) => ({ id: c.id, name: c.name, kind: 'client' as const })),
    ...accounts.map((a) => ({ id: a.id, name: a.name, kind: 'account' as const })),
  ];
}

/* ------------------------------------------------------------------ *
 * Reclassification
 * ------------------------------------------------------------------ */

/**
 * Change what a transaction is, by hand.
 *
 * Refused once the transaction has been allocated: the allocation was made on
 * the strength of the classification, and changing it underneath would leave
 * a payment on an invoice that the row no longer claims to be. Undo first.
 */
export async function reclassify(
  transactionId: string,
  input: {
    kind: BankTxnKind;
    clientId?: string | null;
    accountId?: string | null;
    driverId?: string | null;
    vehicleId?: string | null;
  },
): Promise<BankResult> {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
    select: { id: true, allocatedAt: true },
  });
  if (!txn) return { ok: false, code: 'NOT_FOUND', message: 'No such transaction' };

  if (txn.allocatedAt) {
    return {
      ok: false,
      code: 'ALLOCATED',
      message:
        'This transaction has already been allocated. Undo the allocation first, then reclassify it.',
    };
  }

  await prisma.bankTransaction.update({
    where: { id: transactionId },
    data: {
      kind: input.kind,
      clientId: input.clientId ?? null,
      accountId: input.accountId ?? null,
      driverId: input.driverId ?? null,
      vehicleId: input.vehicleId ?? null,
      // Hand-classified, so no rule can be blamed for it later.
      matchedRuleId: null,
    },
  });

  return { ok: true, id: transactionId };
}

/* ------------------------------------------------------------------ *
 * Proposals
 * ------------------------------------------------------------------ */

export type TransactionProposal =
  | { kind: 'invoices'; proposal: AllocationProposal; payerName: string }
  | { kind: 'payout'; match: PayoutMatch }
  | { kind: 'cost'; suggestedKind: string; vehicleId: string | null }
  | { kind: 'ignore'; reason: string }
  | { kind: 'none'; reason: string };

/**
 * What this transaction would do, if confirmed.
 *
 * Computed on demand rather than stored, so it always reflects the invoices
 * as they are now. A proposal cached at import time would offer to settle an
 * invoice somebody paid by card in the meantime.
 */
export async function proposeFor(
  transactionId: string,
): Promise<TransactionProposal> {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
    include: { client: true, account: true },
  });
  if (!txn) return { kind: 'none', reason: 'No such transaction' };

  if (txn.allocatedAt) {
    return { kind: 'none', reason: 'Already allocated' };
  }

  switch (txn.kind) {
    case 'TRANSFER':
      return {
        kind: 'ignore',
        reason:
          'A transfer between your own accounts. Neither income nor cost, so nothing is created from it.',
      };

    case 'CLIENT_PAYMENT':
    case 'RENTAL_INCOME': {
      if (!txn.clientId && !txn.accountId) {
        return {
          kind: 'none',
          reason:
            'Nothing in the description matched a client or account. Pick who paid and the allocation follows.',
        };
      }

      const invoices = await prisma.invoice.findMany({
        where: {
          ...(txn.clientId ? { clientId: txn.clientId } : { accountId: txn.accountId }),
          status: { in: ['SENT', 'PART_PAID', 'OVERDUE'] },
        },
        select: {
          id: true,
          number: true,
          issueDate: true,
          dueDate: true,
          grossPence: true,
          paidPence: true,
          status: true,
        },
      });

      return {
        kind: 'invoices',
        proposal: proposeAllocation(txn.amountPence, invoices),
        payerName: txn.client?.name ?? txn.account?.name ?? 'Unknown',
      };
    }

    case 'DRIVER_PAYOUT': {
      const payouts = await prisma.driverPayout.findMany({
        where: { status: 'APPROVED' },
        include: { driver: true },
      });

      const matchable: MatchablePayout[] = payouts.map((payout) => ({
        id: payout.id,
        driverName: payout.driver.name,
        totalPence: payout.totalPence,
        periodStart: payout.periodStart,
        periodEnd: payout.periodEnd,
        status: payout.status,
      }));

      return { kind: 'payout', match: matchPayout(txn.amountPence, matchable) };
    }

    case 'FUEL':
      return { kind: 'cost', suggestedKind: 'OTHER', vehicleId: txn.vehicleId };

    case 'VEHICLE_COST':
      return { kind: 'cost', suggestedKind: 'OTHER', vehicleId: txn.vehicleId };

    default:
      return {
        kind: 'none',
        reason: 'Unclassified. Say what it is and a proposal follows.',
      };
  }
}

/* ------------------------------------------------------------------ *
 * Confirming
 * ------------------------------------------------------------------ */

/**
 * Apply the invoice allocation.
 *
 * Everything in one transaction: the `Payment` rows a manual entry or a
 * gateway webhook would have written, the invoice totals and statuses, the
 * `BankAllocation` rows that record what happened, and the leftover as an
 * `UnallocatedCredit`. Either all of it lands or none of it does — a partial
 * allocation is a set of invoices nobody can reason about.
 *
 * The proposal is recomputed here rather than trusted from the caller. The
 * screen the operator confirmed is a view; the invoices are the truth, and
 * they may have moved since it was rendered.
 */
export async function confirmInvoiceAllocation(
  transactionId: string,
  context: AuditContext = {},
): Promise<BankResult<{ allocated: number; unallocated: number }>> {
  const proposal = await proposeFor(transactionId);
  if (proposal.kind !== 'invoices') {
    return {
      ok: false,
      code: 'NOT_ALLOCATABLE',
      message:
        proposal.kind === 'none'
          ? proposal.reason
          : 'This transaction is not a payment against invoices.',
    };
  }

  const txn = await prisma.bankTransaction.findUniqueOrThrow({
    where: { id: transactionId },
  });

  if (proposal.proposal.allocations.length === 0 && proposal.proposal.unallocatedPence === 0) {
    return {
      ok: false,
      code: 'NOTHING_TO_DO',
      message: 'There is nothing outstanding for this payer to settle.',
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
    for (const allocation of proposal.proposal.allocations) {
      const before = await tx.invoice.findUniqueOrThrow({
        where: { id: allocation.invoiceId },
      });

      const payment = await tx.payment.create({
        data: {
          invoiceId: allocation.invoiceId,
          gateway: 'bank',
          amountPence: allocation.amountPence,
          status: 'received',
          receivedAt: txn.occurredOn,
          gatewayTxnId: txn.fingerprint,
        },
      });

      const paidPence = before.paidPence + allocation.amountPence;
      const after = await tx.invoice.update({
        where: { id: allocation.invoiceId },
        data: {
          paidPence,
          status: statusFor(
            {
              status: before.status as InvoiceStatus,
              grossPence: before.grossPence,
              paidPence,
              dueDate: before.dueDate,
              creditedPence: await creditedPenceFor(tx, allocation.invoiceId),
            },
            txn.occurredOn,
          ),
          paidAt: paidPence >= before.grossPence ? txn.occurredOn : null,
        },
      });

      await tx.bankAllocation.create({
        data: {
          transactionId,
          invoiceId: allocation.invoiceId,
          amountPence: allocation.amountPence,
          paymentId: payment.id,
          createdById: context.userId ?? null,
        },
      });

      await tx.auditLog.create({
        data: {
          entity: 'Invoice',
          entityId: allocation.invoiceId,
          action: 'update',
          userId: context.userId ?? null,
          ip: context.ip ?? null,
          before: toJson(before),
          after: toJson(after),
        },
      });
    }

    // Money over is a balance the payer is entitled to, not a rounding
    // problem. Recorded against them so the next invoice can draw on it.
    if (proposal.proposal.unallocatedPence > 0) {
      await tx.unallocatedCredit.create({
        data: {
          clientId: txn.clientId,
          accountId: txn.accountId,
          transactionId,
          amountPence: proposal.proposal.unallocatedPence,
          remainingPence: proposal.proposal.unallocatedPence,
          note: `From ${txn.description} on ${txn.occurredOn.toISOString().slice(0, 10)}`,
        },
      });
    }

    await claim(tx, transactionId, proposal.proposal.allocatedPence);
    });
  } catch (error) {
    if (error instanceof AlreadyAllocatedError) {
      return { ok: false, code: 'ALLOCATED', message: error.message };
    }
    throw error;
  }

  return {
    ok: true,
    id: transactionId,
    allocated: proposal.proposal.allocatedPence,
    unallocated: proposal.proposal.unallocatedPence,
  };
}

/**
 * Mark an approved payout paid from a debit.
 *
 * The payout id is passed rather than re-derived, because the ambiguous case
 * — two drivers owed the same amount — is resolved by a person looking at the
 * screen, and their choice is the input.
 */
export async function confirmPayoutMatch(
  transactionId: string,
  payoutId: string,
  context: AuditContext = {},
): Promise<BankResult> {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
  });
  if (!txn) return { ok: false, code: 'NOT_FOUND', message: 'No such transaction' };
  if (txn.allocatedAt) {
    return { ok: false, code: 'ALLOCATED', message: 'Already allocated.' };
  }

  const payout = await prisma.driverPayout.findUnique({
    where: { id: payoutId },
    include: { lines: true },
  });
  if (!payout) return { ok: false, code: 'NOT_FOUND', message: 'No such payout' };

  if (payout.status !== 'APPROVED') {
    return {
      ok: false,
      code: 'NOT_APPROVED',
      message:
        payout.status === 'PAID'
          ? 'That payout is already marked paid.'
          : 'Approve the payout before matching a payment to it.',
    };
  }

  // The amounts differing is not fatal — a bank charge, or a driver paid in
  // two instalments — but it is worth saying out loud rather than quietly
  // marking a £1,240 payout paid from a £124 debit.
  if (Math.abs(txn.amountPence) !== payout.totalPence) {
    const [paid, owed] = await Promise.all([
      formatPence(Math.abs(txn.amountPence)),
      formatPence(payout.totalPence),
    ]);
    return {
      ok: false,
      code: 'AMOUNT_MISMATCH',
      message: `The payment is ${paid} and the payout is ${owed}. Match one of the same amount, or record the difference against the payout by hand.`,
    };
  }

  await withAudit(
    'DriverPayout',
    'update',
    async (tx) => {
      const before = await tx.driverPayout.findUniqueOrThrow({
        where: { id: payoutId },
        include: { lines: true },
      });

      for (const line of before.lines) {
        if (!line.jobId) continue;
        await tx.jobFinance.upsert({
          where: { jobId: line.jobId },
          update: {
            driverPayStatus: 'FULLY_PAID',
            driverPaidAt: txn.occurredOn,
            driverPaymentPence: line.amountPence,
          },
          create: {
            jobId: line.jobId,
            driverPayStatus: 'FULLY_PAID',
            driverPaidAt: txn.occurredOn,
            driverPaymentPence: line.amountPence,
          },
        });
      }

      const after = await tx.driverPayout.update({
        where: { id: payoutId },
        data: {
          status: 'PAID',
          paidAt: txn.occurredOn,
          paymentReference: txn.bankRef ?? txn.description,
        },
        include: { lines: true },
      });

      await tx.bankAllocation.create({
        data: {
          transactionId,
          payoutId,
          amountPence: Math.abs(txn.amountPence),
          createdById: context.userId ?? null,
        },
      });

      await claim(tx, transactionId, Math.abs(txn.amountPence));
      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: { driverId: payout.driverId },
      });

      return { entityId: payoutId, before, after, result: null };
    },
    context,
  );

  return { ok: true, id: transactionId };
}

/**
 * Record a debit as a cost against a vehicle.
 *
 * Writes the same `VehicleCost` the fleet screens write, so a fuel bill that
 * arrived through the bank and one typed in by hand land in the same place
 * and the per-vehicle profit figures include both.
 */
export async function confirmVehicleCost(
  transactionId: string,
  input: { vehicleId: string; kind: string; note?: string | null },
  context: AuditContext = {},
): Promise<BankResult> {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
  });
  if (!txn) return { ok: false, code: 'NOT_FOUND', message: 'No such transaction' };
  if (txn.allocatedAt) {
    return { ok: false, code: 'ALLOCATED', message: 'Already allocated.' };
  }
  if (txn.amountPence >= 0) {
    return {
      ok: false,
      code: 'NOT_A_COST',
      message: 'That is money coming in, so it is not a cost.',
    };
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: input.vehicleId },
    select: { id: true },
  });
  if (!vehicle) return { ok: false, code: 'NOT_FOUND', message: 'No such vehicle' };

  await prisma.$transaction(async (tx) => {
    const cost = await tx.vehicleCost.create({
      data: {
        vehicleId: input.vehicleId,
        kind: input.kind as never,
        amountPence: Math.abs(txn.amountPence),
        incurredOn: txn.occurredOn,
        supplier: txn.description,
        invoiceRef: txn.bankRef,
        note: input.note ?? 'From the bank statement',
        createdById: context.userId ?? null,
      },
    });

    await tx.bankAllocation.create({
      data: {
        transactionId,
        costId: cost.id,
        amountPence: Math.abs(txn.amountPence),
        createdById: context.userId ?? null,
      },
    });

    await claim(tx, transactionId, Math.abs(txn.amountPence));
    await tx.bankTransaction.update({
      where: { id: transactionId },
      data: { vehicleId: input.vehicleId },
    });
  });

  await recordAudit('Vehicle', 'update', input.vehicleId, {
    after: {
      cost: Math.abs(txn.amountPence),
      from: 'bank statement',
      description: txn.description,
    },
  }, context);

  return { ok: true, id: transactionId };
}

/**
 * Mark a transfer as needing nothing.
 *
 * Not an allocation in any real sense, but it takes the row out of the
 * unreconciled total, which is the number the operator is trying to get to
 * zero. Reversible like everything else.
 */
export async function confirmIgnore(
  transactionId: string,
  context: AuditContext = {},
): Promise<BankResult> {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
  });
  if (!txn) return { ok: false, code: 'NOT_FOUND', message: 'No such transaction' };
  if (txn.allocatedAt) {
    return { ok: false, code: 'ALLOCATED', message: 'Already dealt with.' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.bankAllocation.create({
      data: {
        transactionId,
        amountPence: 0,
        createdById: context.userId ?? null,
      },
    });
    await claim(tx, transactionId, Math.abs(txn.amountPence));
  });

  return { ok: true, id: transactionId };
}

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

/**
 * Reverse everything one transaction created.
 *
 * Spec 4.8.3.6. The payments are deleted, the invoices go back to the
 * `paidPence` and status they had, a payout returns to `APPROVED`, a vehicle
 * cost is soft-deleted, and the unallocated credit is dropped.
 *
 * The invoice status is recomputed from the restored `paidPence` rather than
 * being remembered, so an invoice that went overdue in the meantime comes
 * back as overdue rather than as merely sent. Remembering the old status
 * would restore a stale fact.
 *
 * Refused when the credit has been drawn on: another invoice is now relying
 * on money this undo would remove, and unpicking that silently is how a
 * ledger stops adding up.
 */
export async function undoAllocation(
  transactionId: string,
  context: AuditContext = {},
): Promise<BankResult<{ reversed: number }>> {
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
    include: { allocations: true },
  });
  if (!txn) return { ok: false, code: 'NOT_FOUND', message: 'No such transaction' };
  if (!txn.allocatedAt) {
    return {
      ok: false,
      code: 'NOT_ALLOCATED',
      message: 'Nothing has been allocated from this transaction.',
    };
  }

  const credits = await prisma.unallocatedCredit.findMany({
    where: { transactionId },
  });
  const drawnOn = credits.find(
    (credit) => credit.remainingPence !== credit.amountPence,
  );
  if (drawnOn) {
    return {
      ok: false,
      code: 'CREDIT_SPENT',
      message:
        'Part of the credit from this payment has already been used against another invoice. Reverse that first.',
    };
  }

  await prisma.$transaction(async (tx) => {
    for (const allocation of txn.allocations) {
      if (allocation.invoiceId) {
        const before = await tx.invoice.findUniqueOrThrow({
          where: { id: allocation.invoiceId },
        });

        if (allocation.paymentId) {
          await tx.payment.deleteMany({ where: { id: allocation.paymentId } });
        }

        const paidPence = Math.max(0, before.paidPence - allocation.amountPence);
        const after = await tx.invoice.update({
          where: { id: allocation.invoiceId },
          data: {
            paidPence,
            // Recomputed from SENT, because that is the state an invoice
            // returns to when its payments go away; `statusFor` decides
            // between sent, part-paid and overdue from the dates. Credits are
            // not payments and do not go away with them, so they still count.
            status: statusFor(
              {
                status: before.status === 'CANCELLED' ? 'CANCELLED' : 'SENT',
                grossPence: before.grossPence,
                paidPence,
                dueDate: before.dueDate,
                creditedPence: await creditedPenceFor(tx, allocation.invoiceId),
              },
              new Date(),
            ),
            paidAt: paidPence >= before.grossPence ? before.paidAt : null,
          },
        });

        await tx.auditLog.create({
          data: {
            entity: 'Invoice',
            entityId: allocation.invoiceId,
            action: 'update',
            userId: context.userId ?? null,
            ip: context.ip ?? null,
            before: toJson(before),
            after: toJson(after),
          },
        });
      }

      if (allocation.payoutId) {
        await tx.driverPayout.update({
          where: { id: allocation.payoutId },
          data: { status: 'APPROVED', paidAt: null, paymentReference: null },
        });

        const lines = await tx.driverPayoutLine.findMany({
          where: { payoutId: allocation.payoutId },
        });
        for (const line of lines) {
          if (!line.jobId) continue;
          await tx.jobFinance.updateMany({
            where: { jobId: line.jobId },
            data: { driverPayStatus: 'UNPAID', driverPaidAt: null },
          });
        }
      }

      if (allocation.costId) {
        await tx.vehicleCost.update({
          where: { id: allocation.costId },
          data: { deletedAt: new Date() },
        });
      }
    }

    await tx.unallocatedCredit.deleteMany({ where: { transactionId } });
    await tx.bankAllocation.deleteMany({ where: { transactionId } });
    await tx.bankTransaction.update({
      where: { id: transactionId },
      data: { allocatedAt: null, allocatedPence: 0 },
    });
  });

  return { ok: true, id: transactionId, reversed: txn.allocations.length };
}

/**
 * Claim a transaction inside the transaction that is about to act on it.
 *
 * `proposeFor` checks `allocatedAt` before the write begins, which is a
 * check-then-act with a gap in it: two confirms racing — a double-clicked
 * button is enough — both read "not allocated" and both allocate, and the
 * invoices end up paid twice from one credit.
 *
 * The conditional update closes it. Only one of the two matches
 * `allocatedAt: null`, and the loser throws, which rolls its whole
 * transaction back rather than leaving half an allocation behind.
 */
async function claim(
  // Only what it needs, rather than the full transaction client: the
  // extended client's `$transaction` hands out a slightly different type,
  // and widening this is cheaper than casting at every call site.
  tx: {
    bankTransaction: {
      updateMany: (args: {
        where: { id: string; allocatedAt: null };
        data: { allocatedAt: Date; allocatedPence: number };
      }) => Promise<{ count: number }>;
    };
  },
  transactionId: string,
  allocatedPence: number,
): Promise<void> {
  const claimed = await tx.bankTransaction.updateMany({
    where: { id: transactionId, allocatedAt: null },
    data: { allocatedAt: new Date(), allocatedPence },
  });
  if (claimed.count !== 1) {
    throw new AlreadyAllocatedError();
  }
}

class AlreadyAllocatedError extends Error {
  constructor() {
    super('This transaction was allocated a moment ago.');
    this.name = 'AlreadyAllocatedError';
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Currency and locale from settings, never a hardcoded pound sign. */
async function formatPence(pence: number): Promise<string> {
  const locale = await getLocaleConfig();
  return formatMoney(pence, { currency: locale.currency, locale: locale.locale });
}
