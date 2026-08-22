import { nameBoardDocument } from '@/lib/name-board';
import { resolveNameBoard } from '@/lib/name-board-store';

/**
 * `GET /board/:token` — the name board, for holding up.
 *
 * A route handler rather than a page, on purpose. A page would sit inside the
 * application's layouts and inherit its stylesheet, its theme and its chrome
 * — none of which belong on something held above somebody's head in an
 * arrivals hall. This serves one self-contained document and nothing else.
 *
 * Unauthenticated, because the person holding it is a driver and drivers have
 * no login: they interact with this system through Telegram, which is where
 * the link reaches them. The token in the path is the whole credential, which
 * is why it is 24 random bytes and why a leaked one can be reissued.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const board = await resolveNameBoard(token);

  if (!board) {
    // Plain, and identical for a made-up token, a revoked one and a job that
    // has been called off. Anything more specific confirms which.
    return new Response('This board is no longer available.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(nameBoardDocument([board.name], 'screen'), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      /*
       * Never cached, anywhere.
       *
       * A name corrected at nine has to reach a board already open on a
       * driver's phone, and a board for a job that has just been cancelled
       * has to stop working. `private` because a shared cache holding a
       * passenger's name is exactly what the token exists to prevent.
       */
      'Cache-Control': 'private, no-store, max-age=0',
      // The link is handed out; it has no business being followed by a
      // crawler or reported to wherever the driver came from.
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
