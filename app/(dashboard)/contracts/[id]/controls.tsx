'use client';

import { CalendarPlus } from 'lucide-react';
import { useTransition } from 'react';
import { ConfirmAction } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { generateNowAction, setContractActiveAction } from '../actions';

/**
 * Stopping a contract, and booking its days now.
 *
 * Stopping is confirmed: it is one click from an arrangement somebody is
 * relying on, and the consequence — no more days — is not visible until the
 * morning a car does not turn up.
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
          description="No more days will be created. The ones already booked stay — they are bookings a client is expecting, so cancel any of them individually."
          confirmLabel="Stop it"
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
        Stopping makes no more days. The days it already created are bookings a
        client is expecting, so they stay — cancel any individually.
      </p>
    </>
  );
}
