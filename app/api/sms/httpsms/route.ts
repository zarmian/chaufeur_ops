import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/secret-store';
import { inboundTextFrom, verifyHttpSmsJwt } from '@/lib/httpsms';
import { consumeRateLimit } from '@/lib/rate-limit';
import { placeInboundText } from '@/lib/tracking-chat-store';
import { UNROUTABLE_NOTE } from '@/lib/tracking-chat-inbound';

/**
 * `POST /api/sms/httpsms` — a text arriving on the office's gateway phone.
 *
 * The other half of the SMS fallback: a driver with no Telegram is texted the
 * passenger's message, and whatever they text back lands here and goes onto
 * the passenger's page.
 *
 * Three things govern it.
 *
 * **The JWT is verified before the body is read**, against the signing key
 * stored with the SMS credentials. Without that, anybody who found this URL
 * could put words in a driver's mouth on a page a client is watching.
 *
 * **An unrecognised event is a 200 and a no-op.** httpSMS retries a 5xx four
 * times and then gives up, so answering an event we do not act on with an
 * error turns one ignored message into five.
 *
 * **A text that cannot be placed goes to the office rather than nowhere.** A
 * driver who texts "stuck on the M4" has told somebody something useful, and
 * the Telegram handler already relays a message that is not a reply to
 * anything. Silently dropping it would be the one outcome worse than guessing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = await signingKey();

  if (!secret) {
    /*
     * No key configured, so nothing can be trusted.
     *
     * 503 rather than 200: this is the install not being finished, and a 200
     * would have httpSMS discard every driver reply while the office believed
     * the feature worked.
     */
    return NextResponse.json(
      { error: 'No httpSMS signing key is configured on this install' },
      { status: 503 },
    );
  }

  // The raw body is not needed for the signature — httpSMS signs a JWT rather
  // than the payload — but it is still read once and parsed once.
  const raw = await request.text();

  const check = verifyHttpSmsJwt({
    authorization: request.headers.get('authorization'),
    secret,
  });

  if (!check.ok) {
    /*
     * Rate limited on failures only, keyed on nothing but the bucket.
     *
     * A valid webhook is never counted, so a busy office is never throttled.
     * What this stops is somebody who has found the URL hammering it while
     * guessing, which would otherwise be free.
     */
    await consumeRateLimit('webhookAuth', 'httpsms');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const text = inboundTextFrom(safeJson(raw));
  if (!text) {
    // A delivery receipt, or a shape from a version that moved on.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const placed = await placeInboundText(text);

  if (placed.placed) {
    return NextResponse.json({ ok: true, jobId: placed.jobId });
  }

  /*
   * Not placed, so the office gets it.
   *
   * Best-effort and never allowed to fail the response: httpSMS gives the
   * handler five seconds and retries a 5xx, so a Telegram outage must not
   * turn one unplaceable text into five.
   */
  await relayToOps(text.from, text.body, placed).catch(() => {});

  return NextResponse.json({ ok: true, placed: false, reason: placed.reason });
}

/** The signing key httpSMS puts in the webhook's JWT, decrypted. */
async function signingKey(): Promise<string | null> {
  const row = await prisma.setting.findUnique({
    where: { key: 'client-messaging' },
  });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const value = stored.smsWebhookSecret;

  if (typeof value !== 'string' || value === '') return null;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

async function relayToOps(
  from: string,
  body: string,
  placed: Extract<Awaited<ReturnType<typeof placeInboundText>>, { placed: false }>,
): Promise<void> {
  const { notifyOps } = await import('@/lib/telegram/send');
  const { escapeMarkdown } = await import('@/lib/telegram/protocol');

  const who = placed.driverName ?? from;
  const note = UNROUTABLE_NOTE[placed.reason];

  await notifyOps(
    [
      `📩 *Text from ${escapeMarkdown(who)}*`,
      escapeMarkdown(`Arrived ${note}, so the passenger has not seen it.`),
      '',
      escapeMarkdown(body.slice(0, 500)),
    ].join('\n'),
  );
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
