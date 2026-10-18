'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

/**
 * Set a duplicate sheet aside.
 *
 * Its own component only because it needs `useActionState`, and the page it
 * sits on is a Server Component. The row is kept rather than deleted: a sheet
 * read and deliberately not booked is worth seeing later, and deleting it
 * would make the next copy of the same file look new again.
 */
export function DiscardButton({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction}>
      {state.error ? (
        <p className="mb-2 text-sm text-destructive">{state.error}</p>
      ) : null}
      <SubmitButton label="Set this sheet aside" variant="outline" />
    </form>
  );
}
