'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signIn, signOut } from '@/lib/auth';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIpFrom,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MINUTES,
} from '@/lib/rate-limit';

export interface LoginState {
  error: string | null;
}

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address'),
  password: z.string().min(1, 'Enter your password'),
});

/**
 * The message on failure is deliberately identical whether the email exists,
 * the password is wrong, or the account is deactivated. Anything more
 * specific turns the login form into an account enumeration oracle.
 */
const GENERIC_FAILURE = 'That email and password combination is not recognised';

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? GENERIC_FAILURE };
  }

  const ip = clientIpFrom(await headers());
  const limit = await checkLoginRateLimit(ip);
  if (!limit.allowed) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return {
      error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}. (${LOGIN_MAX_ATTEMPTS} attempts per ${LOGIN_WINDOW_MINUTES} minutes.)`,
    };
  }

  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
  } catch (error) {
    // `signIn` throws NEXT_REDIRECT on success in some configurations; let
    // that propagate rather than reporting it as a failed login.
    if (isRedirectError(error)) throw error;
    return { error: GENERIC_FAILURE };
  }

  await clearLoginFailures(ip);
  redirect('/');
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' });
}

function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
