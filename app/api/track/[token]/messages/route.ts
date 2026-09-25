import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import { postFromPassenger } from '@/lib/tracking-chat-store';
import { resolveTracking } from '@/lib/tracking-store';

/**
 * `POST /api/track/:token/messages` — a passenger's message to their driver.
 *
 * The only endpoint in this system where somebody with no account can put
 * words on a driver's phone, so it is worth being explicit about what guards
 * it and why each is there.
 *
 * **The token is the whole credential**, as it is for the page itself, and it
 * is resolved through exactly the same function — so a link outside its window
 * or belonging to a finished journey cannot post, and cannot be told apart
 * from one that never existed.
 *
 * **The thread's own rules decide the rest.** Whether a driver is assigned,
 * reachable and within the two-hour window is `lib/tracking-chat.ts`'s
 * judgement, made once and used by both the page and this handler: a box the
 * page renders as closed must not be a box this route accepts.
 *
 * **Rate limited per journey**, not per IP. The abuse worth stopping is one
 * driver being buried under a forwarded link, and twenty phones in a group
 * chat share a journey but not an address.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(
  async (request: Request, context: { params: Promise<{ token: string }> }) => {
    const { token } = await context.params;

    // Resolved before anything is read off the request: an unknown token gets
    // the page's answer, which says nothing about whether it was ever real.
    const page = await resolveTracking(token);
    if (!page) {
      return NextResponse.json(
        { message: 'This link is no longer available.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (!page.chat.open) {
      return NextResponse.json(
        { message: 'Messages are closed for this journey.' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const limit = await consumeRateLimit('trackingChat', page.jobId);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          message:
            'That is a lot of messages. Give your driver a moment to read them.',
        },
        {
          status: 429,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': String(limit.retryAfterSeconds),
          },
        },
      );
    }

    const body = (await request.json().catch(() => null)) as {
      body?: unknown;
    } | null;

    const result = await postFromPassenger(page.jobId, body?.body);

    if (!result.ok) {
      return NextResponse.json(
        { message: result.message },
        {
          status: result.code === 'INVALID' ? 400 : 409,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    /*
     * The message comes back with whether it actually reached the driver.
     *
     * Recorded and undelivered is a real outcome — Telegram off, a driver who
     * blocked the bot — and the difference between "they have not replied" and
     * "they never heard you" is the whole difference between waiting and
     * ringing the office.
     */
    return NextResponse.json(
      {
        id: result.message.id,
        body: result.message.body,
        delivered: result.message.deliveredAt !== null,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  },
);
