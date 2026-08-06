import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { deleteRateRule, saveRateRule } from '@/lib/pricing/config';
import { rateRuleSchema } from '@/lib/pricing/schema';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/pricing/rate-cards/:id/rules` — spec 4.2.2 and 4.2.5.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
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
    const user = await requireCapability('manageSettings');
    const context = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();
    const intent = String(form.get('intent') ?? '');
    const ruleId = String(form.get('ruleId') ?? '') || null;

    if (intent === 'delete') {
      if (!ruleId) throw new Error('No rule named');
      const result = await deleteRateRule(id, ruleId, context);
      if (!result.ok) query.set('ruleError', result.message);
    } else if (intent === 'save') {
      const parsed = rateRuleSchema.safeParse({
        jobType: String(form.get('jobType') ?? ''),
        vehicleClass: String(form.get('vehicleClass') ?? ''),
        fromZoneId: String(form.get('fromZoneId') ?? ''),
        toZoneId: String(form.get('toZoneId') ?? ''),
        baseFare: String(form.get('baseFare') ?? ''),
        perHour: String(form.get('perHour') ?? ''),
        minimumHours: String(form.get('minimumHours') ?? ''),
        freeWaitMinutes: String(form.get('freeWaitMinutes') ?? '15'),
        waitPerMinute: String(form.get('waitPerMinute') ?? ''),
        driverBase: String(form.get('driverBase') ?? ''),
        driverPerHour: String(form.get('driverPerHour') ?? ''),
        driverPctOfFare: String(form.get('driverPctOfFare') ?? ''),
        priority: String(form.get('priority') ?? '0'),
      });

      if (!parsed.success) {
        query.set(
          'ruleError',
          parsed.error.issues[0]?.message ?? 'That rule could not be saved',
        );
      } else {
        const result = await saveRateRule(id, ruleId, parsed.data, context);
        if (!result.ok) {
          query.set('ruleError', result.message);
          // Keep the operator on the rule they were editing, so a refusal
          // does not also lose what they typed the way back to it.
          if (ruleId) query.set('edit', ruleId);
        }
      }
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
    headers: {
      Location: `/settings/pricing/rate-cards/${id}?${query.toString()}`,
    },
  });
}
