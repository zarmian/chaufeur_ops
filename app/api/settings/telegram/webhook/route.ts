import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import {
  confirmWebhook,
  registerConfiguredWebhooks,
} from '@/lib/telegram/webhook-admin';

/**
 * `POST /api/settings/telegram/webhook` — point the bots at this install.
 *
 * Spec 5.1.4, finally. Registration was a `curl` in `docs/deployment.md` with
 * a token and a URL pasted into it, run at the end of a long checklist — and
 * the mistake it invites is the worst one available: a bot has exactly one
 * webhook, so pointing a second install at a bot the first is already using
 * silently redirects that company's drivers into this database.
 *
 * `register` writes both configured bots, `check` only asks. Both report
 * where each bot is actually pointed afterwards, because Telegram answering
 * "ok" says it accepted the call, not that the bot belongs to this install.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    await requireCapability('manageSettings');
    const form = await request.formData();
    const intent = String(form.get('intent') ?? 'check');

    const outcomes =
      intent === 'register'
        ? await registerConfiguredWebhooks()
        : await Promise.all([confirmWebhook('ops'), confirmWebhook('admin')]);

    const configured = outcomes.filter(
      (outcome) => !(!outcome.ok && outcome.message.includes('No ')),
    );

    if (configured.length === 0) {
      query.set('telegramError', 'No bot token is configured yet.');
    } else {
      const failures = configured.filter((outcome) => !outcome.ok);
      if (failures.length === 0) {
        query.set(
          'telegramNotice',
          intent === 'register'
            ? `Registered. ${configured.map((o) => o.bot).join(' and ')} now deliver here.`
            : 'Both webhooks point at this install.',
        );
      } else {
        query.set(
          'telegramError',
          failures
            .map((failure) => `${failure.bot}: ${!failure.ok ? failure.message : ''}`)
            .join(' — '),
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
      'telegramError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be done',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/telegram?${query.toString()}` },
  });
}
