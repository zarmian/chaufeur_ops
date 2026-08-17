'use server';

import { cookies } from 'next/headers';
import {
  parseThemePreference,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  type ThemePreference,
} from '@/lib/theme-preference';

/**
 * Remember which theme this person wants.
 *
 * Not `httpOnly`: the pre-paint script has to be able to see the choice, and
 * there is nothing here worth protecting — the value is one of three words
 * and says nothing about the account. `sameSite: 'lax'` all the same, so it
 * is not sent on cross-site requests that have no use for it.
 *
 * The value is parsed rather than trusted: this is a Server Action, so the
 * argument is whatever the request body said it was.
 */
export async function setThemePreference(
  preference: ThemePreference,
): Promise<void> {
  const store = await cookies();
  store.set(THEME_COOKIE, parseThemePreference(preference), {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: 'lax',
  });
}
