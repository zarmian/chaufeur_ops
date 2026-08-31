import { z } from 'zod';
import { hashPassword, verifyPassword } from './password';
import { prisma } from './prisma';
import {
  checkAccountRateLimit,
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

  /*
   * And again, against the account.
   *
   * After parsing, because the email is the key — and before the password is
   * verified, so a throttled account costs an attacker an argon2id hash they
   * do not get to make us compute.
   *
   * This is the half that survives a rotated `X-Forwarded-For` or a botnet.
   * The per-IP check above is still worth having: it catches the same person
   * working through a list of accounts, which the per-account check would
   * never see.
   */
  const accountLimit = await checkAccountRateLimit(email);
  if (!accountLimit.allowed) {
    // Recorded, so a sustained spray is visible in the attempt log rather
    // than silently absorbed.
    await recordLoginAttempt(context.ip, email, false);
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: accountLimit.retryAfterSeconds,
    };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      mustChangePassword: true,
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
    clearLoginFailures(context.ip, email),
  ]);

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export async function signOut(): Promise<void> {
  await destroySession();
}
