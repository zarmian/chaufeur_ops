import { withAudit, type AuditContext } from './audit';
import { financeAmountsFrom } from './job-finance';
import type { ListParams } from './list-params';
import { sumPence } from './money';
import {
  buildPayoutLines,
  type PayoutDraft,
  type PayoutExpense,
  type PayoutJob,
  type PayoutShift,
} from './payout-lines';
import { prisma } from './prisma';
import { shiftPayPence } from './shifts';

/**
 * Creating, approving and settling driver payouts.
 *
 * The arithmetic and the never-pay-twice rule live in `lib/payout-lines.ts`.
 * What this owns is the part that touches money in the database: a job
 * appears on one payout and only one, and approving-and-paying flips every
 * job it covers in a single transaction.
 *
 * Refusals come back as values in the same shape the invoice store uses:
 * most of them are rules an operator needs to read, not faults to log.
 */

export interface PayoutPeriod {
  from: Date;
  to: Date;
}

export type PayoutResult =
  { ok: true; id: string } | { ok: false; code: string; message: string };

/**
 * What a driver is owed for a period, before anything is written.
 *
 * Completed work only. A job still in progress has not earned its fee, and a
 * shift still open has no end to compute pay from.
 *
 * Anything already on a live payout is excluded with a reason rather than
 * silently dropped — a driver querying a short payment needs the answer to be
 * visible.
 */
export async function draftFor(
  driverId: string,
  period: PayoutPeriod,
): Promise<PayoutDraft> {
  const [jobs, shifts, expenses, taken] = await Promise.all([
    prisma.job.findMany({
      where: {
        driverId,
        scheduledAt: { gte: period.from, lte: period.to },
        status: 'COMPLETED',
      },
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        driverPricePence: true,
        shiftId: true,
        finance: true,
      },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.driverShift.findMany({
      where: { driverId, startedAt: { gte: period.from, lte: period.to } },
      select: {
        id: true,
        reference: true,
        startedAt: true,
        endedAt: true,
        breakMinutes: true,
        hourlyRatePence: true,
        approvedAt: true,
      },
      orderBy: { startedAt: 'asc' },
    }),
    reimbursableExpenses(driverId, period),
    linesAlreadyTaken(driverId, period),
  ]);

  const payoutJobs: PayoutJob[] = jobs
    .filter((job) => !taken.jobIds.has(job.id))
    .map((job) => ({
      id: job.id,
      reference: job.reference,
      scheduledAt: job.scheduledAt,
      driverPricePence: job.driverPricePence,
      financeDriverPaymentPence:
        financeAmountsFrom(job.finance)?.driverPaymentPence ?? null,
      shiftId: job.shiftId,
    }));

  const payoutShifts: PayoutShift[] = shifts
    .filter((shift) => !taken.shiftIds.has(shift.id))
    .map((shift) => ({
      id: shift.id,
      reference: shift.reference,
      startedAt: shift.startedAt,
      endedAt: shift.endedAt,
      payPence: shiftPayPence(shift),
      approvedAt: shift.approvedAt,
    }));

  const draft = buildPayoutLines({
    jobs: payoutJobs,
    shifts: payoutShifts,
    expenses,
  });

  // Say what was left out because it is already being paid, rather than
  // leaving a driver to notice the gap themselves.
  for (const job of jobs) {
    if (taken.jobIds.has(job.id)) {
      draft.excluded.push({
        reference: job.reference,
        reason: 'Already on another payout',
        code: 'ALREADY_PAID',
      });
    }
  }
  for (const shift of shifts) {
    if (taken.shiftIds.has(shift.id)) {
      draft.excluded.push({
        reference: shift.reference,
        reason: 'Already on another payout',
        code: 'ALREADY_PAID',
      });
    }
  }

  return draft;
}

/**
 * Expenses the driver fronted and the company owes back — spec 4.5.8.
 *
 * Approved and not rejected, and never one the driver is meant to bear: an
 * owner-driver's own fuel is a cost of their business, and reimbursing it
 * would pay for the same litre twice.
 */
async function reimbursableExpenses(
  driverId: string,
  period: PayoutPeriod,
): Promise<PayoutExpense[]> {
  const rows = await prisma.jobExpense.findMany({
    where: {
      submittedByDriverId: driverId,
      approvedAt: { not: null },
      rejectedAt: null,
      borneBy: { not: 'DRIVER' },
      job: {
        scheduledAt: { gte: period.from, lte: period.to },
        status: 'COMPLETED',
      },
    },
    select: {
      id: true,
      jobId: true,
      kind: true,
      amountPence: true,
      note: true,
      job: { select: { reference: true, scheduledAt: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    jobReference: row.job.reference,
    occurredAt: row.job.scheduledAt,
    kind: row.kind,
    amountPence: row.amountPence,
    note: row.note,
  }));
}

/**
 * Jobs and shifts in this period already on a payout — spec 4.5.4.
 *
 * Drafts count. A record sitting on somebody's unapproved draft is one that
 * must not also appear on a second: two operators generating overlapping
 * periods on the same afternoon is exactly how a driver gets paid twice.
 */
async function linesAlreadyTaken(
  driverId: string,
  period: PayoutPeriod,
): Promise<{ jobIds: Set<string>; shiftIds: Set<string> }> {
  const lines = await prisma.driverPayoutLine.findMany({
    where: {
      // Every payout counts, drafts included: `PayoutStatus` has no
      // cancelled state — a draft is discarded rather than cancelled, and a
      // discarded one is soft-deleted out of this query already.
      payout: { driverId },
      OR: [
        { job: { scheduledAt: { gte: period.from, lte: period.to } } },
        { shift: { startedAt: { gte: period.from, lte: period.to } } },
      ],
    },
    select: { jobId: true, shiftId: true },
  });

  return {
    jobIds: new Set(
      lines.map((line) => line.jobId).filter((id): id is string => id !== null),
    ),
    shiftIds: new Set(
      lines
        .map((line) => line.shiftId)
        .filter((id): id is string => id !== null),
    ),
  };
}

/**
 * Every driver with something unpaid in the period — spec 4.5.1.
 *
 * Drivers rather than payouts: the question an operator asks on a Monday is
 * "who is owed money", and answering it should not require them to guess who
 * to look up.
 */
export async function driversOwedIn(
  period: PayoutPeriod,
  driverIds?: string[],
): Promise<
  Array<{ id: string; name: string; reference: string; draft: PayoutDraft }>
> {
  const drivers = await prisma.driver.findMany({
    where: {
      ...(driverIds?.length ? { id: { in: driverIds } } : {}),
      OR: [
        {
          jobs: {
            some: {
              scheduledAt: { gte: period.from, lte: period.to },
              status: 'COMPLETED',
            },
          },
        },
        {
          shifts: {
            some: { startedAt: { gte: period.from, lte: period.to } },
          },
        },
      ],
    },
    select: { id: true, name: true, reference: true },
    orderBy: { name: 'asc' },
    take: 500,
  });

  const owed: Array<{
    id: string;
    name: string;
    reference: string;
    draft: PayoutDraft;
  }> = [];

  for (const driver of drivers) {
    const draft = await draftFor(driver.id, period);
    if (draft.lines.length > 0 || draft.excluded.length > 0) {
      owed.push({ ...driver, draft });
    }
  }

  return owed;
}

/**
 * Write a draft payout.
 *
 * The lines are rebuilt here rather than taken from the caller, for the same
 * reason an invoice computes its own totals: a screen that could post its own
 * amounts could post any amount.
 */
export async function createPayout(
  driverId: string,
  period: PayoutPeriod,
  context: AuditContext,
): Promise<PayoutResult> {
  const draft = await draftFor(driverId, period);

  if (draft.lines.length === 0) {
    return {
      ok: false,
      code: 'NOTHING_TO_PAY',
      message:
        'Nothing payable in that period. Anything left out is listed with the reason — usually an unpriced job or an unapproved shift.',
    };
  }

  try {
    const payout = await withAudit(
      'DriverPayout',
      'create',
      async (tx) => {
        const created = await tx.driverPayout.create({
          data: {
            driverId,
            periodStart: period.from,
            periodEnd: period.to,
            totalPence: draft.totalPence,
            lines: {
              create: draft.lines.map((line) => ({
                jobId: line.jobId,
                shiftId: line.shiftId,
                amountPence: line.amountPence,
                description: line.description,
              })),
            },
          },
          select: { id: true },
        });
        return { entityId: created.id, after: created, result: created };
      },
      context,
    );

    return { ok: true, id: payout.id };
  } catch (error) {
    // The unique index on (driverId, periodStart, periodEnd) is what stops a
    // period being drafted twice. Reported as the rule it is.
    if (
      error instanceof Error &&
      error.message.includes('Unique constraint failed')
    ) {
      return {
        ok: false,
        code: 'PERIOD_TAKEN',
        message:
          'This driver already has a payout for that period. Open it rather than raising a second one.',
      };
    }
    throw error;
  }
}

/** A payout may be edited or removed only while it is a draft. */
export function canEditPayout(status: string): boolean {
  return status === 'DRAFT';
}

/**
 * Approve a payout.
 *
 * Separate from paying it: approval is somebody saying the figures are right,
 * and payment is the bank. Collapsing them would lose the distinction on the
 * one document a driver disputes.
 */
export async function approvePayout(
  payoutId: string,
  context: AuditContext,
): Promise<PayoutResult> {
  const payout = await prisma.driverPayout.findUnique({
    where: { id: payoutId },
    select: { id: true, status: true },
  });
  if (!payout)
    return { ok: false, code: 'NOT_FOUND', message: 'No such payout' };

  if (payout.status !== 'DRAFT') {
    return {
      ok: false,
      code: 'NOT_DRAFT',
      message: 'This payout has already been approved.',
    };
  }

  await withAudit(
    'DriverPayout',
    'update',
    async (tx) => {
      const before = await tx.driverPayout.findUniqueOrThrow({
        where: { id: payoutId },
      });
      const after = await tx.driverPayout.update({
        where: { id: payoutId },
        data: { status: 'APPROVED' },
      });
      return { entityId: payoutId, before, after, result: null };
    },
    context,
  );

  return { ok: true, id: payoutId };
}

/**
 * Mark a payout paid — spec 4.5.3.
 *
 * Every job it covers flips to `FULLY_PAID` in the same transaction as the
 * payout itself. Two statements outside a transaction is how a payout ends up
 * marked paid with half its jobs still reading unpaid, which is unresolvable
 * afterwards: nobody can tell whether the money went out.
 */
export async function markPayoutPaid(
  payoutId: string,
  input: { paidAt: Date; paymentReference: string | null },
  context: AuditContext,
): Promise<PayoutResult> {
  const payout = await prisma.driverPayout.findUnique({
    where: { id: payoutId },
    select: { id: true, status: true },
  });
  if (!payout)
    return { ok: false, code: 'NOT_FOUND', message: 'No such payout' };

  if (payout.status === 'DRAFT') {
    return {
      ok: false,
      code: 'NOT_APPROVED',
      message:
        'Approve it first. Approval is somebody saying the figures are right; paying is the bank, and the two are worth keeping apart.',
    };
  }

  if (payout.status === 'PAID') {
    return {
      ok: false,
      code: 'ALREADY_PAID',
      message: 'This payout has already been marked paid.',
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

      // `driverPayStatus` lives on `JobFinance`, and a job priced at booking
      // may not have a finance row yet. Upserted rather than updated, so a
      // job whose settlement was never opened still ends up saying what the
      // driver was paid — an unpaid-looking job that was in fact paid is the
      // reconciliation problem this whole phase exists to end.
      for (const line of before.lines) {
        if (!line.jobId) continue;
        await tx.jobFinance.upsert({
          where: { jobId: line.jobId },
          update: {
            driverPayStatus: 'FULLY_PAID',
            driverPaidAt: input.paidAt,
            driverPaymentPence: line.amountPence,
          },
          create: {
            jobId: line.jobId,
            driverPayStatus: 'FULLY_PAID',
            driverPaidAt: input.paidAt,
            driverPaymentPence: line.amountPence,
          },
        });
      }

      const after = await tx.driverPayout.update({
        where: { id: payoutId },
        data: {
          status: 'PAID',
          paidAt: input.paidAt,
          paymentReference: input.paymentReference,
        },
        include: { lines: true },
      });

      return { entityId: payoutId, before, after, result: null };
    },
    context,
  );

  return { ok: true, id: payoutId };
}

/** Discard a draft. Only a draft: an approved payout is a commitment. */
export async function deletePayout(
  payoutId: string,
  context: AuditContext,
): Promise<PayoutResult> {
  const payout = await prisma.driverPayout.findUnique({
    where: { id: payoutId },
    select: { id: true, status: true },
  });
  if (!payout)
    return { ok: false, code: 'NOT_FOUND', message: 'No such payout' };

  if (!canEditPayout(payout.status)) {
    return {
      ok: false,
      code: 'NOT_DRAFT',
      message:
        'Only a draft can be discarded. An approved payout is a commitment somebody made, and the record of it stays.',
    };
  }

  await withAudit(
    'DriverPayout',
    'delete',
    async (tx) => {
      const before = await tx.driverPayout.findUniqueOrThrow({
        where: { id: payoutId },
        include: { lines: true },
      });
      await tx.driverPayoutLine.deleteMany({ where: { payoutId } });
      await tx.driverPayout.update({
        where: { id: payoutId },
        data: { deletedAt: new Date() },
      });
      return { entityId: payoutId, before, result: null };
    },
    context,
  );

  return { ok: true, id: payoutId };
}

// ------------------------------------------------------------------ reading

export interface PayoutFilters {
  driverId: string | null;
  status: string | null;
  from: Date | null;
  to: Date | null;
}

export async function listPayouts(params: ListParams, filters: PayoutFilters) {
  const where = {
    ...(filters.driverId ? { driverId: filters.driverId } : {}),
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.from || filters.to
      ? {
          periodStart: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const [rows, total, aggregate, unpaid] = await Promise.all([
    prisma.driverPayout.findMany({
      where,
      orderBy: { periodStart: params.dir === 'asc' ? 'asc' : 'desc' },
      skip: params.skip,
      take: params.take,
      include: {
        driver: { select: { id: true, name: true, reference: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.driverPayout.count({ where }),
    prisma.driverPayout.aggregate({ where, _sum: { totalPence: true } }),
    // Spec 4.5.7 — what is still owed, across the whole filter rather than
    // this page. A total covering page one would look authoritative and be
    // wrong.
    prisma.driverPayout.aggregate({
      where: { ...where, status: { not: 'PAID' } },
      _sum: { totalPence: true },
    }),
  ]);

  return {
    rows,
    total,
    totals: {
      totalPence: aggregate._sum.totalPence ?? 0,
      owedPence: unpaid._sum.totalPence ?? 0,
    },
  };
}

export async function getPayout(id: string) {
  return prisma.driverPayout.findUnique({
    where: { id },
    include: {
      driver: {
        select: {
          id: true,
          name: true,
          reference: true,
          phone: true,
          email: true,
        },
      },
      lines: {
        include: {
          job: {
            select: {
              id: true,
              reference: true,
              scheduledAt: true,
              pickupText: true,
              dropoffText: true,
            },
          },
          shift: { select: { id: true, reference: true, startedAt: true } },
        },
      },
    },
  });
}

/** Rows for the spreadsheet export, already human-readable. */
export function toPayoutExportRows(
  rows: Array<{
    driver: { name: string; reference: string };
    periodStart: Date;
    periodEnd: Date;
    totalPence: number;
    status: string;
    paidAt: Date | null;
    paymentReference: string | null;
  }>,
) {
  return rows.map((row) => ({
    Driver: row.driver.name,
    Reference: row.driver.reference,
    From: row.periodStart.toISOString().slice(0, 10),
    To: row.periodEnd.toISOString().slice(0, 10),
    Total: row.totalPence / 100,
    Status: row.status,
    Paid: row.paidAt ? row.paidAt.toISOString().slice(0, 10) : '',
    'Payment reference': row.paymentReference ?? '',
  }));
}

/** What every listed payout adds up to, for a tile. */
export function payoutTotal(rows: Array<{ totalPence: number }>): number {
  return sumPence(...rows.map((row) => row.totalPence));
}
