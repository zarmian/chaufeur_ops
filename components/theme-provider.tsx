'use client';

import { MotionConfig } from 'motion/react';
import * as React from 'react';
import type { ThemePreference } from '@/lib/theme-preference';

/**
 * Two things the whole tree needs, and one place to put them.
 *
 * **Reduced motion.** `reducedMotion="user"` makes Motion follow the same
 * signal `app/globals.css` follows, and it does the right thing rather than
 * the blunt thing: transform animations are dropped, opacity animations are
 * kept. So a menu still fades in for somebody who has asked for less motion —
 * they lose the movement, not the feedback. Setting it here means no
 * individual animation has to remember.
 *
 * **Following the machine.** Somebody on `system` who switches their OS to
 * dark at sunset should not have to reload. Only the pre-paint script in
 * `app/layout.tsx` handles the first render; this handles every change after
 * it.
 */
export function ThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    // An explicit choice is not overridden by the machine changing its mind.
    if (preference !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      document.documentElement.classList.toggle('dark', media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [preference]);

  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/**
 * Switch the theme now, without waiting for the server.
 *
 * The cookie is what makes the choice survive a reload, but a round trip to
 * set it is far too long to leave the page in the old theme — the click has
 * to land immediately. So the class is written here and the cookie catches
 * up, which also means the change is a *transition* rather than a navigation
 * repaint.
 *
 * `.theme-changing` is added for exactly the length of that transition and
 * removed again. Leaving a permanent transition on `background-color` would
 * make every hover on every surface in the application lag behind the
 * pointer, which is a high price for one interaction a day.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  const dark =
    preference === 'dark' ||
    (preference === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  root.dataset.theme = preference;
  root.classList.add('theme-changing');
  root.classList.toggle('dark', dark);

  // Read from the token rather than repeated here, so the class cannot
  // outlive the transition it exists for if the duration is ever retuned.
  const duration =
    Number.parseFloat(
      getComputedStyle(root).getPropertyValue('--duration-base'),
    ) || 300;

  window.setTimeout(() => root.classList.remove('theme-changing'), duration);
}
