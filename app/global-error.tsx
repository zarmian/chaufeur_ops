'use client';

import { useEffect } from 'react';

/**
 * The last-resort boundary: it replaces the root layout, so it must render
 * its own <html> and cannot use anything from the design system.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error', error);
  }, [error]);

  return (
    <html lang="en-GB">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
            The application could not start. Nothing has been changed.
            {error.digest ? ` Reference: ${error.digest}` : ''}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
