import { NextResponse, type NextRequest } from 'next/server';

/**
 * A cheap first gate, not the authority.
 *
 * Middleware runs on the edge and cannot reach Postgres, so it only checks
 * whether a session cookie is present and bounces anonymous traffic before
 * it costs a render. The real check — does this token resolve to a live,
 * active user — happens in `app/(dashboard)/layout.tsx` and in every Server
 * Action via `requireUser`. A forged cookie gets past here and no further.
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
  // The meet-and-greet name board. Held up by a driver, and drivers have no
  // login — the 24-byte token in the path is the credential, and the route
  // itself refuses anything it does not recognise.
  '/board',
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const hasSession = SESSION_COOKIES.some(
    (name) => request.cookies.get(name)?.value,
  );
  // The path, forwarded so the dashboard layout can tell which page it is
  // rendering. A Server Component cannot ask, and the layout needs to know
  // in order to let /change-password through while redirecting everything
  // else to it.
  if (hasSession) return NextResponse.next({ request: { headers: withPath(request, pathname) } });

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
  return NextResponse.redirect(loginUrl);
}

/** The incoming headers plus the path being requested. */
function withPath(request: NextRequest, pathname: string): Headers {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', pathname);
  return headers;
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
