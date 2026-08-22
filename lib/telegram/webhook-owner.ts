/**
 * Does this bot's webhook point at this install?
 *
 * A Telegram bot has exactly one webhook URL. Give two installs the same bot
 * token and the second one to register wins — from that moment the first
 * company's drivers are accepting jobs, tapping arrival and filing expenses
 * into the second company's database. Every screen still works, nothing logs
 * an error, and it surfaces weeks later as a driver swearing they completed a
 * job the office has no record of.
 *
 * Nothing in the application registers a webhook; it is done by hand at
 * deploy time. So this is the only place the question gets asked, which is
 * why the comparison is here, on its own, and tested.
 */

export type WebhookOwnership =
  /** Registered against this install. */
  | { state: 'ours' }
  /** No webhook at all — messages can be sent, replies will not arrive. */
  | { state: 'none' }
  /** Nothing to compare against, so no answer is possible. */
  | { state: 'unknown'; reason: string }
  /** Registered against somewhere else. Almost always another install. */
  | { state: 'elsewhere'; registered: string };

/**
 * Compared by origin, not by string.
 *
 * Two traps a prefix match walks into. Hostnames are case-insensitive, so an
 * install reachable at `ops.example.com` would disown its own webhook if it
 * had been registered as `OPS.example.com`. And a bare `startsWith` treats
 * `https://ops.example.com.evil.test/hook` as belonging to
 * `https://ops.example.com` — the one case where a wrong answer is worse than
 * no answer. Parsing both and comparing origins is exact on both counts.
 */
export function webhookOwnership(
  registeredUrl: string | null | undefined,
  appUrl: string | null | undefined,
): WebhookOwnership {
  const registered = (registeredUrl ?? '').trim();

  // Telegram reports an empty string, not a missing field, when a bot has no
  // webhook — which is the state a freshly created bot is in.
  if (registered === '') return { state: 'none' };

  const configured = (appUrl ?? '').trim();
  if (configured === '') {
    return { state: 'unknown', reason: 'APP_URL is not set' };
  }

  const ours = originOf(configured);
  const theirs = originOf(registered);

  if (!ours) return { state: 'unknown', reason: `APP_URL is not a URL: ${configured}` };
  if (!theirs) return { state: 'elsewhere', registered };

  return ours === theirs ? { state: 'ours' } : { state: 'elsewhere', registered };
}

/** Scheme, host and port, lower-cased by `URL` itself. Null if unparseable. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
