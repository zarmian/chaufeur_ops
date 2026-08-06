import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { saveTelegramConfig } from '@/lib/telegram/config';

/**
 * `POST /api/settings/telegram` — spec 5.11.
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

    const result = await saveTelegramConfig(
      {
        enabled: flag(form, 'enabled'),
        opsToken: String(form.get('opsToken') ?? ''),
        adminToken: String(form.get('adminToken') ?? ''),
        webhookSecret: String(form.get('webhookSecret') ?? ''),
        dispatchChatId: String(form.get('dispatchChatId') ?? ''),
        opsBotUsername: String(form.get('opsBotUsername') ?? ''),
        notifyOnAssignment: flag(form, 'notifyOnAssignment'),
        requireAcceptance: flag(form, 'requireAcceptance'),
        chaseDocuments: flag(form, 'chaseDocuments'),
        alertUnassigned: flag(form, 'alertUnassigned'),
        requestLocation: flag(form, 'requestLocation'),
        acceptanceWindowMinutes: number(form.get('acceptanceWindowMinutes'), 15),
        unassignedAlertHours: number(form.get('unassignedAlertHours'), 3),
        locationRetentionDays: number(form.get('locationRetentionDays'), 30),
      },
      { userId: user.id, ip: clientIpFrom(await headers()) },
    );

    if (!result.ok) query.set('telegramError', result.message);
    else query.set('telegramNotice', 'Saved.');
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'telegramError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/telegram?${query.toString()}` },
  });
}

/**
 * A checkbox, read from the last value posted.
 *
 * Each toggle posts a hidden `false` followed by a `true` when checked, so
 * the *last* value is the answer. Reading the first would make every toggle
 * permanently off.
 */
function flag(form: FormData, name: string): boolean {
  const values = form.getAll(name).map(String);
  return values[values.length - 1] === 'true';
}

function number(input: FormDataEntryValue | null, fallback: number): number {
  const value = Number(String(input ?? '').trim());
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
