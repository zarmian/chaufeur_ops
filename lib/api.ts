import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { captureError, type ErrorContext } from './observability';
import { ForbiddenError, UnauthenticatedError } from './permissions';
import { zodFields } from './zod-fields';

/**
 * The error envelope from `docs/api-spec.md`:
 * `{ error: { code, message, fields? } }`.
 *
 * One shape for every failure means the client never has to guess, and the
 * codes are stable enough to branch on.
 */

export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  INVALID_TRANSITION: 409,
  DOCUMENT_EXPIRED: 409,
  PRICE_REQUIRED: 409,
  INVOICE_LOCKED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string[]>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function apiError(
  code: ErrorCode,
  message: string,
  fields?: Record<string, string[]>,
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, ...(fields ? { fields } : {}) } },
    { status: ERROR_STATUS[code] },
  );
}

export { zodFields } from './zod-fields';

/**
 * Wrap a route handler so thrown auth, validation and API errors become the
 * documented response instead of an unhandled 500.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiError) {
        return apiError(error.code, error.message, error.fields);
      }
      if (error instanceof UnauthenticatedError) {
        return apiError('UNAUTHENTICATED', error.message);
      }
      if (error instanceof ForbiddenError) {
        return apiError('FORBIDDEN', error.message);
      }
      if (error instanceof ZodError) {
        return apiError('VALIDATION_FAILED', 'Validation failed', zodFields(error));
      }
      // Spec 6.7.6 — captured with user context, because a stack trace with
      // nobody attached to it is one nobody can reproduce. Awaited so a
      // serverless invocation cannot be frozen before the report leaves.
      await captureError(error, await routeContext(args));
      return apiError('INTERNAL', 'Something went wrong');
    }
  };
}

/**
 * Who and where, for the error report — spec 6.7.6.
 *
 * Best effort by construction. This runs while handling a failure, and a
 * session lookup that throws here would replace the real error with a
 * useless one; a report with no user attached beats no report.
 *
 * The first argument to a route handler is the `Request`, when there is one.
 */
async function routeContext(args: unknown[]): Promise<ErrorContext> {
  const request = args[0];
  let where = 'route';
  if (request instanceof Request) {
    try {
      const url = new URL(request.url);
      where = `${request.method} ${url.pathname}`;
    } catch {
      where = request.method;
    }
  }

  try {
    const { getCurrentUser } = await import('./authz');
    const user = await getCurrentUser();
    if (user) return { where, userId: user.id, userRole: user.role };
  } catch {
    // Unauthenticated, or no request context at all. Report it anyway.
  }

  return { where };
}

/** The list envelope: `{ data, page, pageSize, total }`. */
export interface ListResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Clamp pagination input so no caller can ask for the whole table. */
export function paginationFrom(searchParams: URLSearchParams): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const rawPage = Number(searchParams.get('page') ?? 1);
  const rawSize = Number(searchParams.get('pageSize') ?? DEFAULT_PAGE_SIZE);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(Math.floor(rawSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Constant-time-ish bearer check for cron routes. */
export function isAuthorisedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization');
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < header.length; i += 1) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
