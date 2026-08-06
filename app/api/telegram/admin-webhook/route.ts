import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { handleAdminCommand } from '@/lib/telegram/admin';
import { webhookSecret } from '@/lib/telegram/config';
import type { Update } from '@/lib/telegram/handle';
import { logUpdate } from '@/lib/telegram/send';

/**
 * `POST /api/telegram/admin-webhook` — the staff bot — spec 5.9.
 *
 * A separate endpoint from the driver webhook because it is a separate bot
 * with a separate token, and mixing them would mean one compromised token
 * reaching both audiences.
 *
 * The same three rules apply: check the secret before parsing, answer 200
 * inside five seconds, never fail. Everything the admin bot does is read-only,
 * so a retried update is harmless — but the habit is worth keeping.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADER = 'x-telegram-bot-api-secret-token';

export async function POST(request: Request) {
  const expected = await webhookSecret();

  if (!expected) {
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'Webhook secret is not set' } },
      { status: 401 },
    );
  }

  const supplied = request.headers.get(HEADER);
  if (!supplied || !safeEqual(supplied, expected)) {
    await logUpdate({
      bot: 'admin',
      kind: 'rejected',
      outcome: 'bad or missing secret token',
    });
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Bad secret token' } },
      { status: 401 },
    );
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    await logUpdate({ bot: 'admin', kind: 'malformed', outcome: 'body was not JSON' });
    return NextResponse.json({ ok: true });
  }

  const started = Date.now();
  const chatId = update.message?.chat?.id;
  const text = update.message?.text ?? '';

  if (typeof chatId === 'number' && text.startsWith('/')) {
    try {
      const result = await handleAdminCommand(BigInt(chatId), text);
      await logUpdate({
        bot: 'admin',
        chatId: BigInt(chatId),
        kind: result.kind,
        payload: text.split(/\s/)[0] ?? null,
        outcome: result.outcome,
        handledMs: Date.now() - started,
      });
    } catch (error) {
      await logUpdate({
        bot: 'admin',
        chatId: BigInt(chatId),
        kind: 'error',
        outcome: error instanceof Error ? error.message : 'unknown failure',
      });
    }
  }

  return NextResponse.json({ ok: true });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
