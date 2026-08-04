/**
 * Form state shapes, kept out of `actions.ts`.
 *
 * A `'use server'` module may only export async functions — everything it
 * exports becomes a callable server endpoint. Constants and types live here
 * so both the actions and the client components can import them.
 */

export interface ClientFormState {
  error: string | null;
  fields?: Record<string, string[]>;
}

export const INITIAL_CLIENT_FORM_STATE: ClientFormState = { error: null };

export interface ArchiveState {
  error: string | null;
}

export const INITIAL_ARCHIVE_STATE: ArchiveState = { error: null };
