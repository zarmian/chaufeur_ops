import { ZodError } from 'zod';
import { zodFields } from './api';
import { ForbiddenError, UnauthenticatedError } from './permissions';

/**
 * One shape for every form's result.
 *
 * Kept in `lib/` rather than beside the actions because a `'use server'`
 * module may export only async functions — every export there becomes a
 * callable endpoint.
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

  throw error instanceof Error ? error : new Error(fallback);
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
