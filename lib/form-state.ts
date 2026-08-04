import { ZodError } from 'zod';
import { zodFields } from './zod-fields';
import { ForbiddenError, UnauthenticatedError } from './permissions';

/**
 * One shape for every form's result.
 *
 * Kept in `lib/` rather than beside the actions because a `'use server'`
 * module may export only async functions — every export there becomes a
 * callable endpoint.
 *
 * Client Components import `INITIAL_FORM_STATE` from here, so everything this
 * module reaches ends up in the browser bundle. It must not import anything
 * that touches Postgres, `next/server` or `node:*`. `zodFields` lives in its
 * own leaf module for exactly that reason, and the Prisma check below is
 * duck-typed rather than done with `instanceof`.
 */

export interface FormState {
  error: string | null;
  fields?: Record<string, string[]>;
}

export const INITIAL_FORM_STATE: FormState = { error: null };

/**
 * Turn a thrown error into something the form can render.
 *
 * Validation becomes per-field messages; a role failure becomes a plain
 * sentence; anything else rethrows, because an unexpected error should reach
 * the boundary and the logs rather than being flattened into "something went
 * wrong" beside a field.
 */
export function toFormState(
  error: unknown,
  fallback = 'That could not be saved',
): FormState {
  if (error instanceof ZodError) {
    return { error: 'Check the highlighted fields', fields: zodFields(error) };
  }
  if (error instanceof ForbiddenError) return { error: error.message };
  if (error instanceof UnauthenticatedError) return { error: 'Please sign in again' };

  // Domain errors carry a message written for the operator, so use it.
  if (error instanceof Error && error.name.startsWith('Duplicate')) {
    return { error: error.message };
  }

  // A unique-constraint violation that got past the explicit duplicate check —
  // two operators saving the same registration in the same second, say. It is
  // a collision the operator can act on, not a fault, so it belongs on the
  // form rather than on the error page.
  const conflict = uniqueConstraintTarget(error);
  if (conflict) {
    return { error: `That ${conflict} is already in use on another record` };
  }

  throw error instanceof Error ? error : new Error(fallback);
}

/**
 * The field named by a Prisma P2002, or null.
 *
 * Recognised by shape rather than `instanceof
 * Prisma.PrismaClientKnownRequestError`, because importing `@prisma/client`
 * here would put the Prisma runtime in the browser bundle — see the note at
 * the top of this module.
 */
function uniqueConstraintTarget(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; code?: unknown; meta?: unknown };

  if (
    candidate.name !== 'PrismaClientKnownRequestError' ||
    candidate.code !== 'P2002'
  ) {
    return null;
  }

  const target = (candidate.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target)
    ? target.filter((entry): entry is string => typeof entry === 'string')
    : typeof target === 'string'
      ? [target]
      : [];

  if (fields.length === 0) return 'value';
  // `normalisedRegistration` is an implementation detail; the operator typed
  // a registration.
  return fields
    .map((field) => field.replace(/^normalised/, '').replace(/Id$/, ''))
    .map((field) => field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
    .join(' and ');
}

/** `redirect()` throws by design; never treat that as a failure. */
export function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    ((error as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
      (error as { digest: string }).digest.includes('NEXT_HTTP_ERROR_FALLBACK'))
  );
}
