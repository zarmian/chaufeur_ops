'use client';

import { RouteError } from '@/components/route-error';

export default function Error(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <RouteError {...props} area="setup" />
      </div>
    </div>
  );
}
