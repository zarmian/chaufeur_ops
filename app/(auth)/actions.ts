'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signInWithCredentials, signOut } from '@/lib/auth';
import { safeInternalPath } from '@/lib/safe-path';
import {
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
  next: z.string().optional(),
});

/**
 * Identical wording whether the email exists, the password is wrong, or the
 * account is deactivated. Anything more specific turns the login form into
 * an account-enumeration oracle.
 */
const GENERIC_FAILURE = 'That email and password combination is not recognised';

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? GENERIC_FAILURE };
  }

  const ip = clientIpFrom(await headers());
  const result = await signInWithCredentials(
    { email: parsed.data.email, password: parsed.data.password },
    { ip },
  );

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      return {
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}. (${LOGIN_MAX_ATTEMPTS} attempts per ${LOGIN_WINDOW_MINUTES} minutes.)`,
      };
    }
    return { error: GENERIC_FAILURE };
  }

  // Only ever redirect within this application — an open redirect here would
  // let a phishing link bounce a freshly authenticated user off-site.
  const destination = safeInternalPath(parsed.data.next);
  redirect(destination);
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect('/login');
}
