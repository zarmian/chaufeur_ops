'use client';

import { AlertCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * The body of every route segment's error boundary.
 *
 * The user gets a recovery action and a digest they can quote; the detail
 * goes to the server log, because an error message can carry a client name
 * or a price and this screen may be over someone's shoulder.
 */
export function RouteError({
  error,
  reset,
  area,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  area?: string;
}) {
  useEffect(() => {
    console.error(`Route error${area ? ` in ${area}` : ''}`, error);
  }, [error, area]);

  return (
    <Alert variant="destructive" className="max-w-2xl">
      <AlertCircle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {area
            ? `This ${area} page could not be loaded.`
            : 'This page could not be loaded.'}{' '}
          Nothing has been changed.
        </p>
        {error.digest ? (
          <p className="text-xs opacity-80">Reference: {error.digest}</p>
        ) : null}
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
