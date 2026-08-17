import { Skeleton } from '@/components/ui/skeleton';

/**
 * What a route shows while its data is on the way.
 *
 * The skeleton fades in rather than appearing. On a fast navigation the data
 * arrives before the fade finishes, so nothing is shown at all — which is the
 * point: a skeleton that flashes up for eighty milliseconds and is replaced is
 * a flicker, and reads as the page having gone wrong rather than as it having
 * been quick.
 *
 * The delay lives in the animation rather than in a timer, so there is no
 * state, no effect, and nothing to clean up if the route resolves first.
 */
export function RouteLoading() {
  return (
    <div
      className="animate-in fade-in-0 space-y-6 delay-150 duration-base ease-out"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
