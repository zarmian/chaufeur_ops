'use client';

import { AlertCircle } from 'lucide-react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setupAction, type SetupState } from './actions';

const INITIAL: SetupState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Setting up…' : 'Create administrator'}
    </Button>
  );
}

export function SetupForm({ minPasswordLength }: { minPasswordLength: number }) {
  const [state, formAction] = useActionState(setupAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive" data-testid="setup-error">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="token">Setup token</Label>
        <Input id="token" name="token" type="password" required autoFocus />
        <p className="text-xs text-muted-foreground">
          The <code>SETUP_TOKEN</code> environment variable, or{' '}
          <code>CRON_SECRET</code> if you did not set one.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Your name</Label>
        <Input id="name" name="name" autoComplete="name" required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={minPasswordLength}
          required
        />
        <p className="text-xs text-muted-foreground">
          At least {minPasswordLength} characters.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
        />
      </div>

      <SubmitButton />
    </form>
  );
}
