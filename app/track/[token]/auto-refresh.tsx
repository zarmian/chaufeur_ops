'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-ask the server while the journey is live.
 *
 * A passenger leaves this page open on a phone in an arrivals hall and
 * expects "on the way" to become "your car is here" without touching
 * anything. Without this it is a snapshot of the moment they opened it, which
 * is the one thing a tracking page must not be.
 *
 * `router.refresh()` rather than a poll of an API: the page is a Server
 * Component, so this re-runs it and swaps the rendered output in place —
 * nothing to keep in sync, and no second code path deciding what a passenger
 * may see.
 *
 * **Only while the tab is visible.** A link left open overnight would
 * otherwise wake every twenty seconds until the battery went, and the server
 * would answer each time. `visibilitychange` also fires when a phone comes
 * back out of a pocket, which is exactly when the passenger wants the newest
 * answer — so hiding the poll behind it costs nothing and refreshes at the
 * moment it matters.
 */

/** Often enough to feel live, rarely enough not to be a load test. */
const INTERVAL_MS = 20_000;

export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Straight away, then on the interval: a phone taken out of a pocket
        // should not wait twenty seconds to admit the car has arrived.
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
