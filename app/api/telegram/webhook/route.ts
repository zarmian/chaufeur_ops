import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { clientIpFrom, consumeRateLimit } from '@/lib/rate-limit';
import { webhookSecret } from '@/lib/telegram/config';
import { handleUpdate, type Update } from '@/lib/telegram/handle';
import { logUpdate } from '@/lib/telegram/send';

/**
 * `POST /api/telegram/webhook` — spec 5.1.3.
 *
 * Three things this route has to get right, and they pull against each other.
 *
 * **It must reject an unsigned request before parsing.** The header is checked
 * first and the body is never read on a mismatch. Anyone who can guess this
 * URL can otherwise post a fabricated `COMPLETED` for any job.
 *
 * **It must answer 200 within five seconds.** Telegram retries anything else,
 * and a retried status tap is a second tap on a button the driver pressed
 * once — which for `ARRIVED` means a wait window that reopens after it has
 * been billed.
 *
 * **It must therefore never fail.** A handler that throws still returns 200,
 * with the failure logged. The alternative is Telegram redelivering an update
 * that was in fact applied.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADER = 'x-telegram-bot-api-secret-token';

export async function POST(request: Request) {
  const expected = await webhookSecret();

  // No secret configured is a refusal, not an open door. An unconfigured
  // webhook that accepted everything would be the most dangerous state this
  // route could be in, and it is the state a half-finished install is in.
  if (!expected) {
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'Webhook secret is not set' } },
      { status: 401 },
    );
  }

  const supplied = request.headers.get(HEADER);
  if (!supplied || !safeEqual(supplied, expected)) {
    // Spec 6.7.5, and only on this branch. Limiting by IP before the token
    // check would throttle Telegram itself, which delivers from many
    // addresses and retries what it cannot deliver — the outcome would be
    // dropped status taps. Counting only failures means the budget is spent
    // exclusively by whoever is guessing at the token.
    const ip = clientIpFrom(request.headers);
    const budget = await consumeRateLimit('webhookAuth', ip);

    // Before parsing. The body is never read.
    await logUpdate({
      bot: 'ops',
      kind: 'rejected',
      outcome: budget.allowed
        ? 'bad or missing secret token'
        : `bad secret token, rate limited (${ip})`,
    });

    if (!budget.allowed) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many attempts' } },
        { status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
      );
    }

    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Bad secret token' } },
      { status: 401 },
    );
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    // Verified as coming from Telegram but unreadable. 200 anyway: retrying
    // will not make it parse, and a 4xx here would have Telegram redelivering
    // the same broken body indefinitely.
    await logUpdate({ bot: 'ops', kind: 'malformed', outcome: 'body was not JSON' });
    return NextResponse.json({ ok: true });
  }

  try {
    await handleUpdate(update, 'ops');
  } catch (error) {
    await logUpdate({
      bot: 'ops',
      kind: 'error',
      outcome: error instanceof Error ? error.message : 'unknown failure',
    });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Constant-time compare.
 *
 * The comparison is short and the attacker controls one side, so a naive
 * `===` leaks the secret a byte at a time to anybody patient enough.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
