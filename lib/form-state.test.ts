import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isRedirectError, toFormState } from './form-state';
import { ForbiddenError, UnauthenticatedError } from './permissions';

/**
 * `toFormState` decides what the operator sees when a save fails: a message
 * beside the form, or the error boundary. Getting that boundary wrong is
 * expensive — "Something went wrong" tells them nothing and loses what they
 * typed — so the split is pinned here.
 */

/** A Prisma unique-constraint violation, shaped as the client throws it. */
function prismaUniqueViolation(target: string[] | string) {
  const error = new Error('Unique constraint failed');
  error.name = 'PrismaClientKnownRequestError';
  return Object.assign(error, { code: 'P2002', meta: { target } });
}

describe('toFormState', () => {
  it('turns validation failures into per-field messages', () => {
    const schema = z.object({ name: z.string().min(1, 'Enter the name') });
    try {
      schema.parse({ name: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const state = toFormState(error);
      expect(state.error).toBe('Check the highlighted fields');
      expect(state.fields?.name).toEqual(['Enter the name']);
    }
  });

  it('shows a role refusal as written, without a field map', () => {
    const state = toFormState(new ForbiddenError('Your role (VIEWER) cannot edit'));
    expect(state.error).toBe('Your role (VIEWER) cannot edit');
    expect(state.fields).toBeUndefined();
  });

  it('asks an expired session to sign in again rather than blaming the form', () => {
    expect(toFormState(new UnauthenticatedError()).error).toBe(
      'Please sign in again',
    );
  });

  it('uses the operator-facing message on a domain duplicate error', () => {
    const error = new Error('KR22 RRZ is already on the fleet');
    error.name = 'DuplicateRegistrationError';
    expect(toFormState(error).error).toBe('KR22 RRZ is already on the fleet');
  });

  it('keeps a unique-constraint race on the form, not the error page', () => {
    // Two operators saving the same registration in the same second get past
    // the explicit duplicate check and collide in Postgres. Before this was
    // handled the P2002 rethrew and they lost everything they had typed.
    const state = toFormState(prismaUniqueViolation(['normalisedRegistration']));
    expect(state.error).toBe('That registration is already in use on another record');
  });

  it('names every column of a composite unique constraint', () => {
    const state = toFormState(prismaUniqueViolation(['make', 'phvBadgeNumber']));
    expect(state.error).toBe(
      'That make and phv badge number is already in use on another record',
    );
  });

  it('still reports a conflict when Prisma names no column', () => {
    expect(toFormState(prismaUniqueViolation([])).error).toContain('already in use');
  });

  it('rethrows a genuinely unexpected error so it reaches the logs', () => {
    // A failed database connection is not something to flatten into a hint
    // beside a text input — it belongs on the error boundary.
    const boom = new Error('Connection terminated unexpectedly');
    expect(() => toFormState(boom)).toThrow('Connection terminated unexpectedly');
  });

  it('does not swallow a Prisma error that is not a unique violation', () => {
    const error = new Error('Record to update not found');
    error.name = 'PrismaClientKnownRequestError';
    Object.assign(error, { code: 'P2025' });
    expect(() => toFormState(error)).toThrow('Record to update not found');
  });

  it('wraps a non-Error throw so the boundary still gets an Error', () => {
    expect(() => toFormState('just a string')).toThrow();
  });
});

describe('isRedirectError', () => {
  it('recognises the throw redirect() uses to unwind', () => {
    // `redirect()` signals by throwing. Treating that as a failure would turn
    // every successful save into an error message.
    expect(isRedirectError({ digest: 'NEXT_REDIRECT;replace;/drivers/1;307;' })).toBe(
      true,
    );
  });

  it('recognises the notFound() fallback digest', () => {
    expect(isRedirectError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toBe(true);
  });

  it('leaves a real error alone', () => {
    expect(isRedirectError(new Error('nope'))).toBe(false);
    expect(isRedirectError(null)).toBe(false);
    expect(isRedirectError({ digest: 42 })).toBe(false);
  });
});
