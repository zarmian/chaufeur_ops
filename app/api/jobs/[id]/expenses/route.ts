import type { ExpenseBearer, ExpenseKind } from '@prisma/client';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { withAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { parseMoney } from '@/lib/money';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/jobs/:id/expenses` — add or remove an itemised expense.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 *
 * `borneBy` is what makes an expense mean anything: recharged to the client
 * it is revenue, borne by the company it is cost, borne by the driver it is
 * neither. Getting that wrong on fuel is the difference between an
 * owner-driver job looking profitable and looking like a loss.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('editJobFinances');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();

    if (String(form.get('intent') ?? '') === 'delete') {
      const expenseId = String(form.get('expenseId') ?? '');
      await withAudit(
        'Job',
        'update',
        async (tx) => {
          // Soft-deleted like everything else — an expense that vanishes is
          // an expense nobody can reconcile a statement against.
          const before = await tx.jobExpense.findUniqueOrThrow({
            where: { id: expenseId },
          });
          await tx.jobExpense.update({
            where: { id: expenseId },
            data: { deletedAt: new Date() },
          });
          return { entityId: id, before, result: null };
        },
        audit,
      );
    } else {
      const amount = String(form.get('amount') ?? '').trim();
      if (amount === '') {
        query.set('expenseError', 'Enter the amount');
      } else {
        const amountPence = parseMoney(amount);
        if (amountPence <= 0) {
          query.set('expenseError', 'Enter an amount greater than zero');
        } else {
          const borneBy = String(form.get('borneBy') ?? 'COMPANY') as ExpenseBearer;
          await withAudit(
            'Job',
            'update',
            async (tx) => {
              const created = await tx.jobExpense.create({
                data: {
                  jobId: id,
                  kind: String(form.get('kind') ?? 'OTHER') as ExpenseKind,
                  amountPence,
                  note: String(form.get('note') ?? '').trim() || null,
                  borneBy,
                  // Kept in step with the bearer so the two can never
                  // contradict each other.
                  rechargeToClient: borneBy === 'CLIENT',
                },
              });
              return { entityId: id, after: created, result: null };
            },
            audit,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'expenseError',
      error instanceof Error ? error.message.slice(0, 200) : 'That could not be saved',
    );
  }

  if (!query.has('expenseError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/jobs/${id}?${query.toString()}` },
  });
}
