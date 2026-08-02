import { notFound, redirect } from 'next/navigation';
import {
  getCurrentUser,
  requireCapability,
  type Capability,
  type SessionUser,
} from './authz';
import { ForbiddenError, UnauthenticatedError } from './permissions';

/**
 * Page-level guards. They translate an authorisation failure into the right
 * HTTP response instead of a 500.
 *
 * A capability failure renders 404 rather than 403 on purpose: if a role
 * cannot use a screen, it does not need to learn that the screen exists.
 * Server Actions and route handlers still return an explicit 403, because
 * there the caller already knows what they asked for.
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
