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
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const hasSession = SESSION_COOKIES.some(
    (name) => request.cookies.get(name)?.value,
  );
  if (hasSession) return NextResponse.next();

  const loginUrl = new URL('/login', request.url);
  // Remember where they were headed so sign-in can return them there.
  if (pathname !== '/') {
    loginUrl.searchParams.set('next', `${pathname}${search}`);
  }
  return NextResponse.redirect(loginUrl);
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
