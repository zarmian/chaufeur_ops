import type { ZodError } from 'zod';

/**
 * Flatten a Zod error into the `fields` map `docs/api-spec.md` specifies.
 *
 * Kept in its own module rather than in `lib/api.ts` because both the API
 * error envelope and `lib/form-state.ts` need it, and `lib/api.ts` imports
 * `next/server`. `lib/form-state.ts` is imported by Client Components, so
 * anything it reaches ends up in the browser bundle — this module imports
 * only a type, and so compiles away to nothing on either side.
 */
export function zodFields(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}
