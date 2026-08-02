import type { UserRole } from '@prisma/client';
import { auth } from './auth';
import {
  can,
  describeCapability,
  ForbiddenError,
  UnauthenticatedError,
  type Capability,
  type SessionUser,
} from './permissions';

/**
 * Session-bound role checks. Server-side and authoritative.
 *
 * The navigation hides what a role cannot reach, but hiding is cosmetic —
 * every Server Action and route handler calls through here, so a
 * hand-crafted POST is refused the same way a hidden button would have been.
 */

export {
  can,
  CAPABILITIES,
  describeCapability,
  ForbiddenError,
  hasRole,
  UnauthenticatedError,
  type Capability,
  type SessionUser,
} from './permissions';

/** The signed-in user, or null. Never throws — for optional-auth rendering. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email || !user.role) return null;
  if (!user.active) return null;
  return {
    id: user.id,
    name: user.name ?? user.email,
    email: user.email,
    role: user.role,
    active: user.active,
  };
}

/** The signed-in user, or throw. Use at the top of any protected surface. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/** The signed-in user, or throw unless they hold one of `roles`. */
export async function requireRole(...roles: UserRole[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    throw new ForbiddenError(
      `This action requires ${roles.join(' or ')}; you are ${user.role}`,
    );
  }
  return user;
}

/** The signed-in user, or throw unless they hold `capability`. */
export async function requireCapability(
  capability: Capability,
): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, capability)) {
    throw new ForbiddenError(
      `Your role (${user.role}) cannot ${describeCapability(capability)}`,
    );
  }
  return user;
}
