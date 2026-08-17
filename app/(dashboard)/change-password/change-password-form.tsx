'use client';

import { AlertCircle } from 'lucide-react';
import { useActionState } from 'react';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SubmitButton } from '@/components/submit-button';
import { Input } from '@/components/ui/input';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

function SetPasswordButton() {
  return <SubmitButton label="Set password" />;
}

export function ChangePasswordForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="max-w-md space-y-6">
      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <FormField name="password" label="New password" required>
        <Input
          {...fieldProps('password')}
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
        />
      </FormField>

      <FormField name="confirm" label="Confirm new password" required>
        <Input
          {...fieldProps('confirm')}
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
        />
      </FormField>

      <SetPasswordButton />
    </form>
  );
}
