'use client';

import { CalendarPlus } from 'lucide-react';
import { useTransition } from 'react';
import { ConfirmAction } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { generateNowAction, setContractActiveAction } from '../actions';

/**
 * Stopping a contract, and booking its days now.
 *
 * Stopping is confirmed, and the dialog has to say what it actually does. It
 * is one click from an arrangement somebody is relying on, and stopping now
 * calls off every day still to come rather than only the ones not yet made —
 * which is a great deal more than "no more days" and the opposite of what this
 * button used to promise.
 */
export function ContractControls({
  contractId,
  active,
}: {
  contractId: string;
  active: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending || !active}
        onClick={() => startTransition(() => generateNowAction(contractId))}
      >
        <CalendarPlus className="mr-1 size-4" aria-hidden />
        Book the next days
      </Button>

      {/*
        Only stopping is confirmed. Starting a contract again makes no days
        until the next run and is undone by the button beside it, so asking
        about it would be a confirmation with nothing to protect — and the
        habit of clicking through those is what makes the one that matters
        stop working.
      */}
      {active ? (
        <ConfirmAction
          className="w-full"
          disabled={pending}
          label="Stop this contract"
          title="Stop this contract?"
          description="No more days will be created, and every day still to come is cancelled — the drivers on them are told. Days already run are untouched, and one that has been invoiced is left alone and named."
          confirmLabel="Stop it and cancel the rest"
          cancelLabel="Leave it running"
          onConfirm={() =>
            startTransition(() => setContractActiveAction(contractId, false))
          }
        />
      ) : (
        <Button
          type="button"
          className="w-full"
          disabled={pending}
          onClick={() =>
            startTransition(() => setContractActiveAction(contractId, true))
          }
        >
          Start it again
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        Stopping makes no more days and calls off the ones still to come. To end
        it on a date instead, set the end date — the days after it are cancelled
        the same way.
      </p>
    </>
  );
}
