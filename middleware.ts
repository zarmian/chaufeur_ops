import { NextResponse, type NextRequest } from 'next/server';
import { checkSameOrigin } from '@/lib/same-origin';
import {
  contentSecurityPolicy,
  createNonce,
  staticSecurityHeaders,
} from '@/lib/security-headers';

/**
 * A cheap first gate, not the authority.
 *
 * Middleware runs on the edge and cannot reach Postgres, so it only checks
 * whether a session cookie is present and bounces anonymous traffic before
 * it costs a render. The real check — does this token resolve to a live,
 * active user — happens in `app/(dashboard)/layout.tsx` and in every Server
 * Action via `requireUser`. A forged cookie gets past here and no further.
 *
 * It is also where the two things that must apply to *every* response live:
 * the security headers, and the cross-origin check on state-changing
 * requests. Both belong here rather than in each route for the same reason —
 * a rule applied in forty places is a rule that is missing from the
 * forty-first, and the forty-first is always the one that matters.
 */

// Kept in step with lib/session.ts. Not imported from there, because that
// module reaches Postgres and middleware runs on the edge.
const SESSION_COOKIES = ['ops_session', '__Secure-ops_session'];

/** Paths that must stay reachable without a session. */
const PUBLIC_PREFIXES = [
  '/login',
  // The first-run bootstrap. It guards itself: the page 404s the moment an
  // administrator exists, and creating one requires the setup token.
  '/setup',
  '/api/health',
  '/api/cron',
  '/api/telegram',
  /*
   * The payment gateways' callbacks, which were never on this list.
   *
   * Revolut and SumUp post server-to-server with no cookie, so middleware was
   * redirecting them to `/login` — a 307 the provider records as a failed
   * delivery, and the handler behind it has never run once. Payments have
   * been arriving and going unrecorded.
   *
   * Found while verifying the cross-origin check, by noticing that the
   * webhook probe came back 307 where the Telegram one came back 401. It
   * fails closed rather than open, so it is a broken feature and not a hole —
   * but the tempting fix is to exempt `/api` wholesale, and that *would* be
   * a hole. The route authenticates itself with an HMAC over the raw body.
   */
  '/api/payments/webhooks',
  // The meet-and-greet name board. Held up by a driver, and drivers have no
  // login — the 24-byte token in the path is the credential, and the route
  // itself refuses anything it does not recognise.
  '/board',
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isDevelopment = process.env.NODE_ENV !== 'production';

  const hasSession = SESSION_COOKIES.some(
    (name) => request.cookies.get(name)?.value,
  );

  /*
   * The cross-origin check, before anything else acts on the request.
   *
   * Ahead of the public-prefix bail on purpose. Those paths are public
   * because they are reached without a session — but if one is reached *with*
   * a session and a foreign origin, that is precisely the case worth
   * refusing, and skipping the check for them would leave a hole shaped
   * exactly like the list.
   */
  const origin = checkSameOrigin({
    method: request.method,
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    host: request.headers.get('host'),
    hasSessionCookie: hasSession,
  });

  if (!origin.ok) {
    // 403 with no detail. An attacker's page cannot read a cross-origin
    // response anyway, and the operator will never see this.
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused' } },
      { status: 403 },
    );
  }

  const nonce = createNonce();
  const csp = contentSecurityPolicy(nonce, { development: isDevelopment });

  /*
   * The nonce reaches Next through the *request* headers.
   *
   * Next reads `Content-Security-Policy` off the incoming request, pulls the
   * nonce out of it and stamps it onto the inline bootstrap scripts it emits.
   * Setting it only on the response would produce a policy no script on the
   * page satisfies — a blank screen rather than a hardened one.
   */
  function decorate(response: NextResponse): NextResponse {
    response.headers.set('Content-Security-Policy', csp);
    for (const [header, value] of Object.entries(
      staticSecurityHeaders({ development: isDevelopment }),
    )) {
      response.headers.set(header, value);
    }
    return response;
  }

  const forwarded = new Headers(request.headers);
  forwarded.set('Content-Security-Policy', csp);
  forwarded.set('x-nonce', nonce);

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return decorate(NextResponse.next({ request: { headers: forwarded } }));
  }

  // The path, forwarded so the dashboard layout can tell which page it is
  // rendering. A Server Component cannot ask, and the layout needs to know
  // in order to let /change-password through while redirecting everything
  // else to it.
  if (hasSession) {
    forwarded.set('x-pathname', pathname);
    return decorate(NextResponse.next({ request: { headers: forwarded } }));
  }

  // Cloned from `nextUrl` rather than built with `new URL(path, request.url)`.
  // The latter resolves against a host Next reconstructs, which is not
  // necessarily the host the browser is on — locally it turned 127.0.0.1 into
  // localhost, a different origin, so the session cookie stopped being sent.
  // Cloning keeps the origin the visitor actually used.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  // Remember where they were headed so sign-in can return them there.
  if (pathname !== '/') {
    loginUrl.searchParams.set('next', `${pathname}${search}`);
  }
  return decorate(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own assets and the favicon. API routes are
     * included so an unauthenticated fetch is redirected rather than
     * reaching a handler that assumes a session.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
