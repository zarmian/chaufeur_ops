import { notFound, redirect } from 'next/navigation';
import {
  getCurrentUser,
  requireCapability,
  type Capability,
  type SessionUser,
} from './authz';
import { ForbiddenError, UnauthenticatedError } from './permissions';

/**
 * Page-level guards. They translate an authorisation failure into a rendered
 * refusal instead of a 500.
 *
 * A capability failure renders the not-found page rather than a "forbidden"
 * screen on purpose: if a role cannot use a screen, it does not need to learn
 * that the screen exists. Server Actions and route handlers still return an
 * explicit 403, because there the caller already knows what they asked for.
 *
 * Note the *status* may still be 200: Next often flushes the dashboard shell
 * before the page component runs, and once bytes are on the wire the status
 * is committed. The refusal is in what gets rendered, which is what actually
 * protects the data.
 */

export async function pageRequireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

export async function pageRequireCapability(
  capability: Capability,
): Promise<SessionUser> {
  try {
    return await requireCapability(capability);
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect('/login');
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
}
