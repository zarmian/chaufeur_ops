/**
 * Whether a state-changing request came from this application.
 *
 * Server Actions get this from Next, which compares `Origin` against `Host`
 * and refuses a mismatch. Plain route handlers get nothing — and this system
 * has around forty of them taking form posts behind a session cookie, because
 * a form post has no hydration window in which a response can be discarded
 * (see the note in `app/api/jobs/[id]/status/route.ts`).
 *
 * Until now their only protection was `SameSite=Lax` on the session cookie.
 * That is real, and it stops a genuine cross-*site* form post — but it is
 * enforced by the browser rather than by this system, and "same site" is a
 * looser thing than "same origin": `blog.customer.com` and `ops.customer.com`
 * are the same site, so a page on one can post to the other with the cookie
 * attached. This is a white-label product where every customer brings their
 * own domain, which makes that a deployment somebody will actually have
 * rather than a thought experiment.
 *
 * Pure and header-only, so the rule is unit-testable rather than something
 * you have to stand a server up to observe.
 */

/** Methods that cannot change anything, and so need no origin. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginVerdict =
  | { ok: true; reason: 'safe method' | 'no session' | 'same origin' }
  | { ok: false; reason: 'origin mismatch' | 'origin missing' };

/**
 * The check.
 *
 * Gated on a session cookie being present, which is what makes it safe to
 * apply everywhere at once. The two unauthenticated POST endpoints in this
 * system — the Telegram webhook and the payment gateways' — are
 * server-to-server, carry no cookie and send no `Origin`, and would otherwise
 * have to be special-cased by path. A rule with no exceptions list cannot
 * have the wrong thing left off it.
 *
 * `Origin` first, `Referer` as a fallback. Browsers have sent `Origin` on
 * every POST for years, so its absence on a cookie-bearing request is already
 * unusual; the fallback exists because a privacy extension or a corporate
 * proxy occasionally strips one but not the other, and refusing an operator's
 * legitimate click is its own kind of failure.
 */
export function checkSameOrigin(input: {
  method: string;
  origin: string | null;
  referer: string | null;
  host: string | null;
  hasSessionCookie: boolean;
}): OriginVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return { ok: true, reason: 'safe method' };
  }

  // No cookie, no cookie to abuse. The request still has to pass whatever
  // authentication the handler does for itself.
  if (!input.hasSessionCookie) return { ok: true, reason: 'no session' };

  if (!input.host) return { ok: false, reason: 'origin missing' };

  const claimed = hostOf(input.origin) ?? hostOf(input.referer);
  if (!claimed) return { ok: false, reason: 'origin missing' };

  return claimed === input.host.toLowerCase()
    ? { ok: true, reason: 'same origin' }
    : { ok: false, reason: 'origin mismatch' };
}

/**
 * The host and port of a URL, or null.
 *
 * Compared against `Host`, which carries the port, so `host` rather than
 * `hostname` — otherwise `localhost:3000` and `localhost:3001` would be
 * treated as the same origin, and in development they are two different
 * applications.
 */
function hostOf(value: string | null): string | null {
  if (!value) return null;
  // Firefox has historically sent this for a privacy-stripped origin, and it
  // is not a match for anything.
  if (value === 'null') return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}
