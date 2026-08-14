'use client';

import { AlertCircle, Check, Copy, KeyRound, Power, PowerOff } from 'lucide-react';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import type { UserFormState } from './actions';

/**
 * The per-row controls: reset a password, switch an account off or on.
 *
 * Each is its own small form so a refusal — "this is the only administrator"
 * — lands next to the person it is about rather than at the top of a list of
 * fifteen.
 */

function Pending({ children, ...props }: React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="secondary" disabled={pending} {...props}>
      {children}
    </Button>
  );
}

export function ResetPasswordButton({
  action,
  name,
}: {
  action: (state: UserFormState, formData: FormData) => Promise<UserFormState>;
  name: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE as UserFormState);
  const [copied, setCopied] = useState(false);

  if (state.temporaryPassword) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
          {state.temporaryPassword}
        </code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(state.temporaryPassword ?? '');
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          <span className="sr-only">Copy {name}’s temporary password</span>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-1">
      <Pending>
        <KeyRound className="mr-1 size-4" />
        Reset password
      </Pending>
      {state.error ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

export function ActiveToggle({
  action,
  active,
  name,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  active: boolean;
  name: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <Pending variant={active ? 'ghost' : 'secondary'}>
        {active ? (
          <PowerOff className="mr-1 size-4" />
        ) : (
          <Power className="mr-1 size-4" />
        )}
        {active ? 'Deactivate' : 'Reactivate'}
        <span className="sr-only"> {name}</span>
      </Pending>
      {state.error ? (
        <Alert variant="destructive" className="mt-1">
          <AlertCircle className="size-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
