import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { saveFlightConfig } from '@/lib/flights/store';
import { blankFlightConfig } from '@/lib/flights/types';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/settings/flights` — save the flight tracking settings.
 *
 * A plain form post, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const form = await request.formData();
    const blank = blankFlightConfig();

    const result = await saveFlightConfig(
      {
        enabled: form.get('enabled') === 'on',
        autoAdjust: form.get('autoAdjust') === 'on',
        lookAheadHours: positive(
          form.get('lookAheadHours'),
          blank.lookAheadHours,
        ),
        refreshMinutes: positive(
          form.get('refreshMinutes'),
          blank.refreshMinutes,
        ),
        minShiftMinutes: positive(
          form.get('minShiftMinutes'),
          blank.minShiftMinutes,
        ),
        minNoticeMinutes: positive(
          form.get('minNoticeMinutes'),
          blank.minNoticeMinutes,
        ),
        apiKey: String(form.get('apiKey') ?? ''),
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    query.set(
      result.ok ? 'flightNotice' : 'flightError',
      result.ok ? 'Saved.' : result.message,
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'flightError',
      error instanceof Error
        ? error.message.slice(0, 300)
        : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/flights?${query.toString()}` },
  });
}

/**
 * A typed interval, or the default.
 *
 * Zero and negatives fall back rather than being stored: a minimum shift of
 * nothing would move a pickup for every one-minute revision, and a driver's
 * phone would buzz all morning with nothing to do about it.
 */
function positive(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}
