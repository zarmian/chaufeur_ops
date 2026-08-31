'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signInWithCredentials } from '@/lib/auth';
import {
  completeInstall,
  isInstallComplete,
  MIN_PASSWORD_LENGTH,
  tokenMatches,
} from '@/lib/install';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIpFrom,
  recordLoginAttempt,
} from '@/lib/rate-limit';

export interface SetupState {
  error: string | null;
}

const setupSchema = z
  .object({
    token: z.string().min(1, 'Enter the setup token'),
    name: z.string().trim().min(1, 'Enter your name'),
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `Use at least ${MIN_PASSWORD_LENGTH} characters`,
      ),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match',
  });

/**
 * Claim a fresh install from the browser.
 *
 * Three gates, in order: the install must not already be claimed, the token
 * must match, and the attempt must be within the rate limit. Failed token
 * attempts are recorded against the login limiter, so the token cannot be
 * brute-forced any faster than a password.
 */
export async function setupAction(
  _previous: SetupState,
  formData: FormData,
): Promise<SetupState> {
  if (await isInstallComplete()) {
    return {
      error:
        'This install has already been set up. Sign in instead, or ask an administrator to add your account.',
    };
  }

  const ip = clientIpFrom(await headers());

  const limit = await checkLoginRateLimit(ip);
  if (!limit.allowed) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return {
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }

  const parsed = setupSchema.safeParse({
    token: formData.get('token'),
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form' };
  }

  if (!tokenMatches(parsed.data.token)) {
    await recordLoginAttempt(ip, 'setup', false);
    return { error: 'That setup token is not correct.' };
  }

  const result = await completeInstall({
    email: parsed.data.email,
    name: parsed.data.name,
    password: parsed.data.password,
  });

  if (!result.ok) {
    return {
      error:
        result.reason === 'already_installed'
          ? 'This install has already been set up. Sign in instead.'
          : 'Setup could not be completed.',
    };
  }

  // Scoped to the account just created, now that a success no longer wipes
  // every failure recorded against the address.
  await clearLoginFailures(ip, parsed.data.email);

  // Sign the new administrator straight in — they have just proved both the
  // token and the password, so a login form here would be ceremony.
  await signInWithCredentials(
    { email: parsed.data.email, password: parsed.data.password },
    { ip },
  );

  redirect('/');
}
