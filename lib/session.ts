import { createHash, randomBytes } from 'node:crypto';
import type { UserRole } from '@prisma/client';
import { cookies } from 'next/headers';
import { prisma } from './prisma';

/**
 * Database-backed sessions.
 *
 * CLAUDE.md asks for Auth.js v5 with a credentials provider *and* database
 * sessions. Auth.js does not support that combination: with
 * `strategy: 'database'` it never runs the `jwt` callback for the credentials
 * provider, so no `Session` row is ever created and the cookie ends up
 * holding a JWT the adapter cannot resolve. The widely-cited `jwt.encode`
 * workaround does not hold in 5.0.0-beta.32 — proven by the Phase 0
 * end-to-end run, where sign-in set a cookie and the dashboard then bounced
 * straight back to the login page.
 *
 * Of the two constraints, the behaviour is the one that matters: database
 * sessions exist so that disabling a user takes effect on their next
 * request rather than whenever a token happens to expire. So the session
 * store is implemented here, directly, and the library choice gives way.
 *
 * The token is random and opaque; only its SHA-256 hash is stored, so a
 * dump of the `Session` table does not hand anyone a live login.
 */

const SESSION_MAX_AGE_DAYS = Number(process.env.SESSION_MAX_AGE_DAYS ?? 30);
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

/** Renew when less than half the lifetime remains, so an active user is not logged out mid-shift. */
const RENEW_THRESHOLD_MS = (SESSION_MAX_AGE_SECONDS * 1000) / 2;

const BASE_COOKIE_NAME = 'ops_session';
const SECURE_COOKIE_NAME = `__Secure-${BASE_COOKIE_NAME}`;

/** Both names, so middleware can look for either without knowing the environment. */
export const SESSION_COOKIE_NAMES = [BASE_COOKIE_NAME, SECURE_COOKIE_NAME];

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function sessionCookieName(): string {
  return isProduction() ? SECURE_COOKIE_NAME : BASE_COOKIE_NAME;
}

/** Sessions are looked up by hash — the raw token exists only in the cookie. */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  /** True while they are still on a temporary password somebody else issued. */
  mustChangePassword: boolean;
}

/**
 * Issue a session and set the cookie. Call only after the password has been
 * verified.
 */
export async function createSession(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: { sessionToken: hashSessionToken(rawToken), userId, expires },
  });

  const store = await cookies();
  store.set(sessionCookieName(), rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires,
  });

  return rawToken;
}

/**
 * Resolve the cookie to a live user, or null.
 *
 * Every check that could revoke access happens here rather than at login:
 * expiry, soft deletion and deactivation. That is the whole point of keeping
 * sessions in the database.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const rawToken =
    store.get(sessionCookieName())?.value ??
    store.get(BASE_COOKIE_NAME)?.value ??
    store.get(SECURE_COOKIE_NAME)?.value;

  if (!rawToken) return null;

  const session = await prisma.session.findUnique({
    where: { sessionToken: hashSessionToken(rawToken) },
    include: {
      // The soft-delete extension does not reach nested includes, so the
      // deleted check is explicit.
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          mustChangePassword: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!session) return null;

  if (
    session.expires.getTime() <= Date.now() ||
    !session.user.active ||
    session.user.deletedAt !== null
  ) {
    await prisma.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (session.expires.getTime() - Date.now() < RENEW_THRESHOLD_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000) },
      })
      .catch(() => {
        // A renewal race is harmless — the session is still valid either way.
      });
  }

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    active: session.user.active,
    mustChangePassword: session.user.mustChangePassword,
  };
}

/** End the current session and clear the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const name = sessionCookieName();
  const rawToken =
    store.get(name)?.value ??
    store.get(BASE_COOKIE_NAME)?.value ??
    store.get(SECURE_COOKIE_NAME)?.value;

  if (rawToken) {
    // Sessions are genuinely deleted. They are not a business record, and a
    // revoked session that lingers is a security bug, not an audit trail.
    await prisma.session.deleteMany({
      where: { sessionToken: hashSessionToken(rawToken) },
    });
  }

  store.delete(name);
  store.delete(BASE_COOKIE_NAME);
}

/** Drop every session for a user. Used when access is revoked or a role changes. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

/** Housekeeping for expired rows. Called by the daily cron. */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expires: { lt: new Date() } },
  });
  return count;
}
