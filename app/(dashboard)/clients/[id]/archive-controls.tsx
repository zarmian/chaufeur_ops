'use client';

import { AlertCircle, Archive, RotateCcw } from 'lucide-react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { archiveClientAction, restoreClientAction } from '../actions';
import { INITIAL_ARCHIVE_STATE } from '../form-state';

function SubmitButton({
  label,
  pendingLabel,
  variant,
  icon,
}: {
  label: string;
  pendingLabel: string;
  variant: 'destructive' | 'outline';
  icon: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {icon}
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function ArchiveControls({
  clientId,
  isArchived,
}: {
  clientId: string;
  isArchived: boolean;
}) {
  const [state, formAction] = useActionState(
    isArchived
      ? restoreClientAction.bind(null, clientId)
      : archiveClientAction.bind(null, clientId),
    INITIAL_ARCHIVE_STATE,
  );

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">
          {isArchived ? 'Restore' : 'Archive'}
        </CardTitle>
        <CardDescription>
          {isArchived
            ? 'Put this client back into the active list.'
            : 'Hides the client from the active list. Nothing is deleted — the record stays, so old jobs and invoices still make sense.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <form action={formAction}>
          {isArchived ? (
            <SubmitButton
              label="Restore client"
              pendingLabel="Restoring…"
              variant="outline"
              icon={<RotateCcw aria-hidden />}
            />
          ) : (
            <SubmitButton
              label="Archive client"
              pendingLabel="Archiving…"
              variant="destructive"
              icon={<Archive aria-hidden />}
            />
          )}
        </form>
      </CardContent>
    </Card>
  );
}
