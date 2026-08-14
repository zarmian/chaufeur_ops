import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { ROLES, ROLE_DESCRIPTIONS } from './enum-options';
import { MIN_PASSWORD_LENGTH } from './install';
import { hashPassword } from './password';
import { prisma } from './prisma';
import { revokeAllSessions } from './session';

export { ROLES, ROLE_DESCRIPTIONS };

/**
 * The people who can sign in, and what stops an install locking itself out.
 *
 * Drivers are not users — they have no dashboard login and reach the system
 * only through the Telegram bot. This module is about staff.
 *
 * Two rules run through everything here, and both exist because the failure
 * they prevent is unrecoverable without a database console:
 *
 * 1. **There is always an active administrator.** Demoting, deactivating or
 *    deleting the last one is refused, whoever asks.
 * 2. **Nobody edits themselves into powerlessness.** An admin cannot change
 *    their own role or switch themselves off, even when other admins exist —
 *    it is almost always a misclick, and the recovery is a support call.
 *
 * Sessions live in the database, so revoking them is immediate rather than
 * whenever a token happens to expire. Every change that should end somebody's
 * access ends it on their next request.
 */

export const userSchema = z.object({
  name: z.string().trim().min(1, 'A user needs a name'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('That is not a valid email address'),
  role: z.enum(ROLES),
});

export const passwordSchema = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `A password needs at least ${MIN_PASSWORD_LENGTH} characters`,
  );

export type UserInput = z.infer<typeof userSchema>;

export type UserRefusal = { ok: false; reason: string };
export type UserResult<T> = { ok: true; value: T } | UserRefusal;

/**
 * A temporary password an administrator can read aloud.
 *
 * Four words and a number rather than random characters: it is going to be
 * typed by somebody reading it off a screen or a phone message, and a
 * mistyped password sends them straight back to the person who issued it.
 * Long enough that the length makes up for the smaller alphabet — four words
 * from this list plus the digits is well past what a guess could reach, and
 * it only has to survive until first sign-in.
 */
const WORDS = [
  'amber', 'anchor', 'atlas', 'beacon', 'birch', 'bridge', 'canvas', 'cedar',
  'cobalt', 'compass', 'copper', 'coral', 'dune', 'ember', 'fable', 'falcon',
  'harbour', 'hazel', 'indigo', 'ivory', 'jasper', 'kestrel', 'lantern',
  'linen', 'marble', 'meadow', 'mosaic', 'nectar', 'nimbus', 'olive', 'onyx',
  'orchard', 'pebble', 'pewter', 'quartz', 'quill', 'ridge', 'saffron',
  'sable', 'slate', 'sorrel', 'spruce', 'sterling', 'thistle', 'topaz',
  'umber', 'velvet', 'walnut', 'willow', 'zephyr',
];

export function generateTemporaryPassword(): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]);
  return `${words.join('-')}-${randomInt(10, 100)}`;
}

/** Everyone who can sign in, newest last. */
export async function listUsers() {
  return prisma.user.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      mustChangePassword: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });
}

export async function getUser(id: string) {
  return prisma.user.findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      mustChangePassword: true,
      lastLoginAt: true,
    },
  });
}

/** Active administrators other than `exceptId`. */
async function otherActiveAdmins(exceptId: string | null): Promise<number> {
  return prisma.user.count({
    where: {
      role: 'ADMIN',
      active: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
}

/**
 * Create a user with a temporary password.
 *
 * The password is returned once, in the result, and never stored in readable
 * form — the caller shows it to the administrator and it is gone. The account
 * is flagged so the dashboard will not open until it has been changed.
 */
export async function createUser(
  input: UserInput,
  context: AuditContext,
): Promise<UserResult<{ id: string; temporaryPassword: string }>> {
  const existing = await prisma.user.findFirst({
    where: { email: input.email },
    select: { id: true, active: true },
  });
  if (existing) {
    return {
      ok: false,
      reason: `${input.email} already has an account${existing.active ? '' : ', currently deactivated'}.`,
    };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const id = await withAudit(
    'User',
    'create',
    async (tx) => {
      const user = await tx.user.create({
        data: { ...input, passwordHash, mustChangePassword: true },
      });
      return {
        entityId: user.id,
        before: null,
        // Never the hash, and never the password. An audit log that carried
        // either would be a second place to steal them from.
        after: { name: user.name, email: user.email, role: user.role },
        result: user.id,
      };
    },
    context,
  );

  return { ok: true, value: { id, temporaryPassword } };
}

/**
 * Change a user's name, email or role.
 *
 * A role change ends their sessions: capabilities are read when a request
 * resolves its session, and somebody demoted mid-shift should not keep the
 * screens they had a moment ago.
 */
export async function updateUser(
  id: string,
  input: UserInput,
  actingUserId: string,
  context: AuditContext,
): Promise<UserResult<null>> {
  const user = await prisma.user.findFirst({
    where: { id },
    select: { id: true, role: true, active: true, email: true },
  });
  if (!user) return { ok: false, reason: 'That user no longer exists' };

  if (id === actingUserId && input.role !== user.role) {
    return {
      ok: false,
      reason: 'You cannot change your own role. Ask another administrator.',
    };
  }

  if (user.role === 'ADMIN' && input.role !== 'ADMIN') {
    if ((await otherActiveAdmins(id)) === 0) {
      return {
        ok: false,
        reason:
          'This is the only administrator. Give somebody else the administrator role first, or nobody will be able to manage users or settings.',
      };
    }
  }

  if (input.email !== user.email) {
    const clash = await prisma.user.findFirst({
      where: { email: input.email, id: { not: id } },
      select: { id: true },
    });
    if (clash) return { ok: false, reason: `${input.email} is already in use.` };
  }

  await withAudit(
    'User',
    'update',
    async (tx) => {
      const before = await tx.user.findUnique({
        where: { id },
        select: { name: true, email: true, role: true },
      });
      const after = await tx.user.update({
        where: { id },
        data: input,
        select: { name: true, email: true, role: true },
      });
      return { entityId: id, before, after, result: null };
    },
    context,
  );

  if (input.role !== user.role) await revokeAllSessions(id);
  return { ok: true, value: null };
}

/**
 * Issue a new temporary password.
 *
 * Every existing session is revoked, because the reason for resetting a
 * password is usually that somebody else may have had it.
 */
export async function resetPassword(
  id: string,
  context: AuditContext,
): Promise<UserResult<{ temporaryPassword: string }>> {
  const user = await prisma.user.findFirst({ where: { id }, select: { id: true } });
  if (!user) return { ok: false, reason: 'That user no longer exists' };

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await withAudit(
    'User',
    'update',
    async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
      });
      return {
        entityId: id,
        before: null,
        after: { passwordReset: true },
        result: null,
      };
    },
    context,
  );

  await revokeAllSessions(id);
  return { ok: true, value: { temporaryPassword } };
}

/**
 * A user choosing their own password.
 *
 * Their other sessions go, but not this one — signing somebody out of the
 * screen they just used to set a password reads as a failure.
 */
export async function changeOwnPassword(
  id: string,
  password: string,
  context: AuditContext,
): Promise<UserResult<null>> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'That password will not do' };
  }

  const passwordHash = await hashPassword(parsed.data);
  await withAudit(
    'User',
    'update',
    async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: false },
      });
      return { entityId: id, before: null, after: { passwordChanged: true }, result: null };
    },
    context,
  );

  return { ok: true, value: null };
}

/** Switch an account off, or back on. */
export async function setUserActive(
  id: string,
  active: boolean,
  actingUserId: string,
  context: AuditContext,
): Promise<UserResult<null>> {
  const user = await prisma.user.findFirst({
    where: { id },
    select: { id: true, role: true, active: true },
  });
  if (!user) return { ok: false, reason: 'That user no longer exists' };

  if (!active) {
    if (id === actingUserId) {
      return { ok: false, reason: 'You cannot deactivate your own account.' };
    }
    if (user.role === 'ADMIN' && (await otherActiveAdmins(id)) === 0) {
      return {
        ok: false,
        reason:
          'This is the only active administrator. Nobody would be able to manage users or settings.',
      };
    }
  }

  await withAudit(
    'User',
    active ? 'restore' : 'delete',
    async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: { active: true } });
      const after = await tx.user.update({
        where: { id },
        data: { active },
        select: { active: true },
      });
      return { entityId: id, before, after, result: null };
    },
    context,
  );

  // The promise `lib/session.ts` exists to keep: deactivating somebody takes
  // effect on their next request, not whenever a token expires.
  if (!active) await revokeAllSessions(id);
  return { ok: true, value: null };
}
