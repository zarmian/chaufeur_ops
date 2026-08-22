/**
 * Where this install lives, as an absolute origin.
 *
 * Almost nothing in the application needs this: a browser knows its own
 * origin, and a PDF renderer is handed one resolved against the request that
 * asked for it (`absoluteLogoSrc` in `lib/invoice-pdf.ts`). The exception is a
 * message *pushed* to somebody — a Telegram job card carrying a link to a name
 * board — because nothing about the outgoing message has a request to resolve
 * against.
 *
 * Returns null rather than guessing. A link built on a wrong origin is worse
 * than no link: the driver taps it, gets nothing, and rings the office.
 */
export function appOrigin(): string | null {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  /*
   * Vercel's own, as a fallback so a deployment works before anyone sets
   * anything.
   *
   * The production domain in preference to `VERCEL_URL`, which is unique to a
   * single deployment: a link built on that keeps working but pins a driver's
   * saved board to a build that will be superseded, and reads like an
   * accident when pasted into a group chat.
   */
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production}`;

  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment) return `https://${deployment}`;

  return null;
}

/** An absolute URL for an app-relative path, or null if the origin is unknown. */
export function absoluteUrl(path: string): string | null {
  const origin = appOrigin();
  return origin ? `${origin}${path.startsWith('/') ? path : `/${path}`}` : null;
}
