'use client';

import { AlertCircle, Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { INITIAL_FORM_STATE } from '@/lib/form-state';
import { ROLES, ROLE_DESCRIPTIONS } from '@/lib/enum-options';
import type { UserFormState } from './actions';

export interface UserFormValues {
  name: string;
  email: string;
  role: string;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

/**
 * The temporary password, shown once.
 *
 * Deliberately loud, and deliberately not stored anywhere: this is the only
 * time it can be read. Copying it is one button because the alternative is
 * somebody transcribing it wrong and coming straight back.
 */
function TemporaryPassword({ password, email }: { password: string; email?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert>
      <AlertDescription className="space-y-3">
        <p className="font-medium">
          {email ? `${email} can now sign in.` : 'New temporary password issued.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-3 py-2 font-mono text-base tracking-wide">
            {password}
          </code>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(password);
              setCopied(true);
            }}
          >
            {copied ? <Check className="mr-1 size-4" /> : <Copy className="mr-1 size-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Give this to them directly. It will not be shown again, and they will
          have to choose their own password before they can use the system. If
          it goes astray, issue another from the user list.
        </p>
      </AlertDescription>
    </Alert>
  );
}

export function UserForm({
  action,
  values,
  submitLabel,
  cancelHref = '/settings/users',
}: {
  action: (state: UserFormState, formData: FormData) => Promise<UserFormState>;
  values?: UserFormValues;
  submitLabel: string;
  cancelHref?: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE as UserFormState);
  const current = values ?? { name: '', email: '', role: 'VIEWER' };
  const [role, setRole] = useState(current.role);

  if (state.temporaryPassword) {
    return (
      <div className="space-y-4">
        <TemporaryPassword password={state.temporaryPassword} email={state.userEmail} />
        <Button asChild>
          <Link href="/settings/users">Back to users</Link>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="name" label="Full name" required errors={state.fields?.name}>
          <Input {...fieldProps('name', state.fields?.name)} defaultValue={current.name} required />
        </FormField>

        <FormField name="email" label="Email" required errors={state.fields?.email}>
          <Input
            {...fieldProps('email', state.fields?.email)}
            type="email"
            defaultValue={current.email}
            required
          />
        </FormField>
      </div>

      <FormField name="role" label="Role" required errors={state.fields?.role}>
        <Select
          {...fieldProps('role', state.fields?.role)}
          defaultValue={current.role}
          onChange={(event) => setRole(event.target.value)}
        >
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
      </FormField>

      {/* What the role means, next to the choice rather than in a help page. */}
      <p className="-mt-3 text-sm text-muted-foreground">
        {ROLE_DESCRIPTIONS[role as keyof typeof ROLE_DESCRIPTIONS]}
      </p>

      <div className="flex gap-2">
        <SubmitButton label={submitLabel} />
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
