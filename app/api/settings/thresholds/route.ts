import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError } from '@/lib/api';
import { withAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { getSettings, setSetting } from '@/lib/settings';

/**
 * `POST /api/settings/thresholds` — the operational numbers.
 *
 * A plain form post to a route handler, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z
  .object({
    complianceWarningDays: z.coerce.number().int().min(1).max(365),
    complianceCriticalDays: z.coerce.number().int().min(1).max(365),
    driverConflictBufferMinutes: z.coerce.number().int().min(0).max(720),
    unpricedAlertThreshold: z.coerce.number().int().min(1).max(1000),
    // Capped at a fortnight: the dispatch page renders every day in the
    // range, so a board asked for a quarter would put several thousand jobs
    // through one render.
    dispatchDaysAhead: z.coerce.number().int().min(1).max(14),
    dispatchUnassignedHours: z.coerce.number().int().min(1).max(72),
    dispatchLateMinutes: z.coerce.number().int().min(1).max(240),
  })
  .superRefine((input, ctx) => {
    if (input.complianceCriticalDays > input.complianceWarningDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['complianceCriticalDays'],
        message:
          'The escalation window has to sit inside the warning window, or nothing is ever amber — every expiring document would jump straight to red.',
      });
    }
  });

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();

    const input = schema.parse({
      complianceWarningDays: form.get('complianceWarningDays') ?? '30',
      complianceCriticalDays: form.get('complianceCriticalDays') ?? '7',
      driverConflictBufferMinutes:
        form.get('driverConflictBufferMinutes') ?? '90',
      unpricedAlertThreshold: form.get('unpricedAlertThreshold') ?? '5',
      dispatchDaysAhead: form.get('dispatchDaysAhead') ?? '4',
      dispatchUnassignedHours: form.get('dispatchUnassignedHours') ?? '4',
      dispatchLateMinutes: form.get('dispatchLateMinutes') ?? '15',
    });

    const before = await getSettings();

    await withAudit(
      'Setting',
      'update',
      async () => {
        for (const [key, value] of Object.entries(input)) {
          await setSetting(key as keyof typeof input, value);
        }
        return { entityId: 'thresholds', before, after: input, result: null };
      },
      audit,
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'settingsError',
      error instanceof z.ZodError
        ? (error.errors[0]?.message ?? 'Those values were not accepted')
        : error instanceof Error
          ? error.message.slice(0, 300)
          : 'That could not be saved',
    );
  }

  if (!query.has('settingsError')) query.set('updated', String(Date.now()));

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/compliance?${query.toString()}` },
  });
}
