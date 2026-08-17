'use client';

import { CalendarPlus } from 'lucide-react';
import { useTransition } from 'react';
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

      <Button
        type="button"
        variant={active ? 'destructive' : 'default'}
        className="w-full"
        disabled={pending}
        onClick={() => {
          if (
            active &&
            !confirm(
              'Stop this contract? No more days will be created. The ones already booked stay.',
            )
          ) {
            return;
          }
          startTransition(() => setContractActiveAction(contractId, !active));
        }}
      >
        {active ? 'Stop this contract' : 'Start it again'}
      </Button>

      <p className="text-xs text-muted-foreground">
        Stopping makes no more days. The days it already created are bookings a
        client is expecting, so they stay — cancel any individually.
      </p>
    </>
  );
}
