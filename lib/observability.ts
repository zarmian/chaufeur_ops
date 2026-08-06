/**
 * Error capture with user context — spec 6.7.6.
 *
 * "Sentry or equivalent". This is the equivalent, and it speaks Sentry: if
 * `SENTRY_DSN` is set the event goes to Sentry over its envelope endpoint,
 * and if it is not the event is written to the log as structured JSON, which
 * is where Vercel's log drains pick it up.
 *
 * No SDK. The Sentry packages bring an instrumentation hook, a bundler
 * plugin, source-map upload and a build step, and this codebase's guardrail
 * is to flag a dependency before adding it. What the spec actually asks for
 * is that a failure reaches somebody with enough context to act on — one
 * `fetch` to a documented endpoint does that. If the team later wants
 * release health and tracing, swapping this for `@sentry/nextjs` is a change
 * behind one function.
 *
 * **User context, not user data.** The id and the role, because "who hit
 * this" is what turns a stack trace into a reproduction. Never the email,
 * never job or client detail, never anything from a request body — an error
 * tracker is a third-party system and the contents of a booking are not its
 * business.
 *
 * Capture never throws. An error while reporting an error must not replace
 * the error, and must not turn a handled 500 into an unhandled one.
 */

export interface ErrorContext {
  /** Where it happened: a route path or a job name. */
  where: string;
  /** Who, when there is a who. Id and role only. */
  userId?: string;
  userRole?: string;
  /** Anything else worth knowing, as long as it is not customer data. */
  extra?: Record<string, string | number | boolean | null>;
}

interface ParsedDsn {
  host: string;
  projectId: string;
  publicKey: string;
  protocol: string;
}

/**
 * `https://<key>@<host>/<project id>`.
 *
 * Returns null rather than throwing on a malformed DSN. A typo in an
 * environment variable should cost the reporting, not the request.
 */
function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId) return null;
    return {
      host: url.host,
      projectId,
      publicKey: url.username,
      protocol: url.protocol.replace(':', ''),
    };
  } catch {
    return null;
  }
}

function describe(error: unknown): { type: string; value: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: error.name || 'Error',
      value: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { type: 'UnknownError', value: String(error) };
}

/**
 * Sentry's envelope format: a newline-delimited body of header, item header,
 * item. Documented at https://develop.sentry.dev/sdk/envelopes/.
 */
function envelope(
  dsn: ParsedDsn,
  error: unknown,
  context: ErrorContext,
): string {
  const { type, value, stack } = describe(error);
  const eventId = crypto.randomUUID().replace(/-/g, '');

  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: context.where,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    // Id and role only. Sending the email would put a person's address in a
    // third-party system for no diagnostic gain.
    user: context.userId
      ? { id: context.userId, ...(context.userRole ? { role: context.userRole } : {}) }
      : undefined,
    tags: { where: context.where, ...(context.userRole ? { role: context.userRole } : {}) },
    extra: context.extra,
    exception: {
      values: [
        {
          type,
          value,
          ...(stack ? { stacktrace: { frames: [], raw: stack } } : {}),
        },
      ],
    },
  };

  return [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
}

export async function captureError(
  error: unknown,
  context: ErrorContext,
): Promise<void> {
  const { type, value, stack } = describe(error);

  // Always logged, whether or not a tracker is configured. The log is the
  // thing that survives an outage of the tracker.
  console.error(
    JSON.stringify({
      level: 'error',
      where: context.where,
      type,
      message: value,
      userId: context.userId ?? null,
      userRole: context.userRole ?? null,
      ...context.extra,
      stack,
    }),
  );

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  const parsed = parseDsn(dsn);
  if (!parsed) {
    console.error('SENTRY_DSN is set but not parseable — errors are log-only');
    return;
  }

  try {
    await fetch(
      `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/envelope/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': [
            'Sentry sentry_version=7',
            `sentry_key=${parsed.publicKey}`,
            // Generic on purpose: this string reaches a third party, and
            // nothing in the codebase names a customer.
            'sentry_client=chauffeur-ops/1.0',
          ].join(', '),
        },
        body: envelope(parsed, error, context),
        // The request that failed is already failing. Waiting on a third
        // party to acknowledge the report would make a slow tracker into a
        // slow application.
        signal: AbortSignal.timeout(3000),
      },
    );
  } catch {
    // Deliberately silent beyond the log above. An error while reporting an
    // error must not replace the error.
  }
}
