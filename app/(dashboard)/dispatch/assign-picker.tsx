'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Select } from '@/components/ui/select';
import { SPRING } from '@/lib/motion';

/**
 * Giving a job to a driver, from the row it is flagged on.
 *
 * The board's other route to this is dragging a card onto a driver's lane in
 * the timeline, which is a good gesture and a bad fit for the question this
 * panel asks. Dragging means finding the driver's row first, and with 195
 * owner-drivers that is a scroll through several screens to reach a name you
 * already had in mind. A list you can type into is faster, works from the
 * keyboard, and — the part that matters on a board somebody works down —
 * leaves the pointer where it was.
 *
 * Posts to the same `/api/dispatch/assign` the drag does, so the compliance
 * block and the clash warning behave identically whichever way the job was
 * given out. Nothing about the rules lives here.
 */
export function AssignPicker({
  jobId,
  drivers,
}: {
  jobId: string;
  drivers: { id: string; name: string; vehicleRegistration: string | null }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function assign(driverId: string) {
    if (!driverId) return;
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch('/api/dispatch/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, driverId }),
      });
      const json = (await response.json()) as {
        ok?: boolean;
        message?: string;
        warning?: string;
      };

      if (!response.ok || !json.ok) {
        setMessage(json.message ?? 'That could not be assigned.');
        return;
      }

      // A clash is a warning, not a refusal — the assignment stands and the
      // operator is told, because they know the traffic and the system does
      // not. Kept on screen rather than lost in the refresh.
      if (json.warning) setMessage(json.warning);
      router.refresh();
    } catch {
      setMessage('That could not be assigned.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-48">
      <label htmlFor={`assign-${jobId}`} className="sr-only">
        Give this job to a driver
      </label>
      <Select
        id={`assign-${jobId}`}
        defaultValue=""
        disabled={busy}
        onChange={(event) => void assign(event.target.value)}
        data-testid="assign-picker"
        data-job-id={jobId}
      >
        <option value="">{busy ? 'Assigning…' : 'Give it to…'}</option>
        {drivers.map((driver) => (
          <option key={driver.id} value={driver.id}>
            {driver.name}
            {driver.vehicleRegistration ? ` · ${driver.vehicleRegistration}` : ''}
          </option>
        ))}
      </Select>

      <AnimatePresence initial={false}>
        {message ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={SPRING.snappy}
            className="overflow-hidden text-xs text-warning-foreground"
            role="status"
            data-testid="assign-message"
          >
            <span className="mt-1 block">{message}</span>
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
