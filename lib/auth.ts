import { z } from 'zod';
import { hashPassword, verifyPassword } from './password';
import { prisma } from './prisma';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  recordLoginAttempt,
} from './rate-limit';
import { createSession, destroySession, type SessionUser } from './session';

/**
 * Sign-in and sign-out.
 *
 * See the note in `lib/session.ts` for why this is hand-rolled rather than
 * Auth.js: the credentials-plus-database-sessions combination Auth.js v5
 * cannot actually deliver.
 */

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type SignInResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'invalid'; }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

/**
 * An argon2id hash of a value nobody knows.
 *
 * Verified against when the email does not exist, so the failure path costs
 * roughly the same time as the success path. Without it, a fast rejection
 * tells an attacker the address is not registered.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomFillerSecret());
  return dummyHashPromise;
}

function randomFillerSecret(): string {
  return `timing-equaliser-${Math.random().toString(36).slice(2)}`;
}

/**
 * Verify credentials and, on success, issue a database session.
 *
 * The caller decides what to tell the user. Every failure returns the same
 * `invalid` reason regardless of cause — wrong password, unknown email, or a
 * deactivated account — because anything more specific turns the login form
 * into an account-enumeration oracle.
 */
export async function signInWithCredentials(
  input: { email: string; password: string },
  context: { ip: string },
): Promise<SignInResult> {
  const parsed = credentialsSchema.safeParse(input);

  const limit = await checkLoginRateLimit(context.ip);
  if (!limit.allowed) {
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  if (!parsed.success) {
    await recordLoginAttempt(context.ip, null, false);
    return { ok: false, reason: 'invalid' };
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      passwordHash: true,
    },
  });

  const storedHash = user?.passwordHash ?? (await dummyHash());
  const passwordMatches = await verifyPassword(storedHash, password);

  if (!user || !user.active || !passwordMatches) {
    await recordLoginAttempt(context.ip, email, false);
    return { ok: false, reason: 'invalid' };
  }

  await createSession(user.id);

  await Promise.all([
    prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }),
    recordLoginAttempt(context.ip, email, true),
    clearLoginFailures(context.ip),
  ]);

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
    },
  };
}

export async function signOut(): Promise<void> {
  await destroySession();
}
