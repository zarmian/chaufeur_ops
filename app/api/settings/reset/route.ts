import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { getBranding } from '@/lib/branding-store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import { runReset } from '@/lib/reset';

/**
 * `POST /api/settings/reset` — empty this install of its operational data.
 *
 * The most destructive thing the application can do, so it is gated three
 * ways: `manageSettings` is ADMIN alone, the operator has to type the
 * install's own trading name, and the screen shows the row count first.
 *
 * The trading name rather than a checkbox or a fixed word, for the reason
 * GitHub asks you to type a repository's name: a phrase everybody types
 * without reading stops being a confirmation. Typing your own company's name
 * requires knowing which install you are on, which is the mistake being
 * defended against.
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
    const branding = await getBranding();

    const typed = String(form.get('confirm') ?? '').trim();
    if (typed.toLowerCase() !== branding.tradingName.trim().toLowerCase()) {
      query.set(
        'resetError',
        `Type ${branding.tradingName} exactly to confirm. Nothing has been changed.`,
      );
    } else {
      // Written to the log before the audit log itself is emptied: after
      // this there is nothing left in the database to say a reset happened,
      // and the drain keeps what the tables will not.
      note('install.reset.requested', {
        userId: user.id,
        ip: clientIpFrom(await headers()),
      });

      const outcome = await runReset();

      if (!outcome.ok) {
        note('install.reset.incomplete', {
          collateral: outcome.collateral,
          remaining: outcome.remaining,
        });
        query.set(
          'resetError',
          outcome.collateral.length > 0
            ? `Emptied, but these were meant to survive and did not: ${outcome.collateral.join(', ')}. Check the install before using it.`
            : `Emptied, but these still hold rows: ${outcome.remaining.join(', ')}.`,
        );
      } else {
        note('install.reset.completed', { removed: outcome.removed });
        query.set(
          'resetNotice',
          `${outcome.removed} rows removed. Settings, rate cards and your sign-in are untouched.`,
        );
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
      'resetError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings?${query.toString()}` },
  });
}

/**
 * A line in the log drain, in the shape `lib/observability.ts` uses, so
 * searching for a level finds this alongside everything else.
 */
function note(event: string, detail: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      logger: 'install.reset',
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
      event,
      ...detail,
    }),
  );
}
