import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { checkDriverConflicts, checkVehicleConflicts } from '@/lib/conflict-store';

import { scheduledAtFrom } from '@/lib/jobs';
import { getLocaleConfig } from '@/lib/locale-store';

/**
 * `POST /api/jobs/conflicts` — is this driver already busy? — spec 6.2.3.
 *
 * Called from the booking form while the operator is still typing, the same
 * way the rate-card quote is. Saves nothing and blocks nothing: it answers a
 * question, and the answer is a sentence the operator reads and then ignores
 * or acts on.
 *
 * A clash is `200` with a warning, not a `409`. Most bookings have no clash
 * and a form that treated "busy" as an error would show a red box on ordinary
 * work — which is how a warning stops being read.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  jobId: z.string().trim().nullable().optional(),
  driverId: z.string().trim().nullable().optional(),
  vehicleId: z.string().trim().nullable().optional(),
  scheduledDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduledTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
  estimatedMinutes: z.coerce.number().int().min(0).max(24 * 60).nullable().optional(),
  hours: z.coerce.number().min(0).max(24).nullable().optional(),
  isContract: z.coerce.boolean().nullable().optional(),
});

export const POST = withErrorHandling(async (request: Request): Promise<Response> => {
  // `viewJobs` rather than `editJobs`: this reads and the booking form is
  // reachable by anyone who can see jobs.
  await requireCapability('viewJobs');

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError('VALIDATION_FAILED', 'That is not a booking');
  }

  const input = parsed.data;
  if (!input.driverId && !input.vehicleId) {
    return NextResponse.json({ warnings: [] });
  }

  const { timeZone } = await getLocaleConfig();

  // Shared with `createJob` rather than reimplemented, so the check and the
  // job it becomes agree about what instant the operator meant.
  const scheduledAt = scheduledAtFrom(
    { scheduledDate: input.scheduledDate, scheduledTime: input.scheduledTime },
    timeZone,
  );

  const proposed = {
    ...(input.jobId ? { id: input.jobId } : {}),
    scheduledAt,
    estimatedMinutes: input.estimatedMinutes ?? null,
    customerHours: input.hours ?? null,
    // A contract day raises no clash at all — the driver and the car do
    // other work around a standing arrangement. See `lib/conflicts.ts`.
    isContract: input.isContract ?? false,
  };

  const [driver, vehicle] = await Promise.all([
    checkDriverConflicts(input.driverId ?? null, proposed),
    checkVehicleConflicts(input.vehicleId ?? null, proposed),
  ]);

  return NextResponse.json({
    warnings: [driver.warning, vehicle.warning].filter(Boolean),
    conflicts: [...driver.conflicts, ...vehicle.conflicts].slice(0, 5).map((c) => ({
      id: c.id,
      reference: c.reference,
      overlapping: c.overlapping,
    })),
  });
});
