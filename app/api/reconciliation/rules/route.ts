import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import type { BankTxnKind } from '@/lib/bank/classify';
import { deleteRule, saveRule } from '@/lib/bank/store';
import { prisma } from '@/lib/prisma';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';

/**
 * `POST /api/reconciliation/rules` — create, toggle, delete.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    await requireCapability('editInvoices');
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');
    const id = String(form.get('id') ?? '').trim();

    if (intent === 'create') {
      const priority = Number(form.get('priority') ?? 0);
      const result = await saveRule(null, {
        phrase: String(form.get('phrase') ?? ''),
        kind: String(form.get('kind') ?? 'FUEL') as BankTxnKind,
        priority: Number.isFinite(priority) ? Math.trunc(priority) : 0,
      });
      if (!result.ok) query.set('ruleError', result.message);
    } else if (intent === 'toggle' && id) {
      await prisma.bankRule.update({
        where: { id },
        data: { active: String(form.get('active')) === 'true' },
      });
    } else if (intent === 'delete' && id) {
      await deleteRule(id);
    } else {
      query.set('ruleError', 'Unknown action');
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'ruleError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  if (!query.has('ruleError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/reconciliation/rules?${query.toString()}` },
  });
}
