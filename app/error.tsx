'use client';

import { RouteError } from '@/components/route-error';

/**
 * The catch-all boundary. Without it, a failure on /login or /setup falls
 * through to global-error.tsx, which replaces the root layout and can only
 * say "the application could not start" — true but useless.
 */
export default function Error(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <RouteError {...props} />
      </div>
    </div>
  );
}
