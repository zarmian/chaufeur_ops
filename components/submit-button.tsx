'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The submit button, while the server is thinking.
 *
 * Every form in the application had its own copy of this — `disabled={pending}`
 * and a label that swapped to "Saving…". Two things were wrong with all of
 * them, and they were wrong the same way in each.
 *
 * **The button changed size.** "Save the job" is wider than "Saving…", so the
 * button shrank on click and the buttons beside it slid across. On a form
 * where the next thing somebody does is click Cancel, the target moves out
 * from under the pointer at the exact moment they are reaching for it. Both
 * labels are stacked in one grid cell here, so the button is always as wide
 * as its widest state and nothing moves.
 *
 * **There was nothing to look at.** On a slow save the button said "Saving…"
 * and then sat perfectly still, which after two seconds is indistinguishable
 * from a page that has hung. A spinner fixes that — but shown immediately it
 * appears and vanishes within a frame or two on every fast save, which is
 * worse than not having one. It waits.
 */

/** Long enough that a fast save never shows one; short enough to reassure. */
const SPINNER_DELAY_MS = 400;

export function SubmitButton({
  label,
  pendingLabel = 'Saving…',
  className,
  ...props
}: Omit<ButtonProps, 'children' | 'type' | 'disabled'> & {
  label: React.ReactNode;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  const showSpinner = useSettledDelay(pending, SPINNER_DELAY_MS);

  return (
    <Button
      type="submit"
      disabled={pending}
      // Announced rather than only drawn: a screen reader gets "busy" without
      // having to notice that a label changed.
      aria-busy={pending}
      className={cn('relative', className)}
      {...props}
    >
      {/*
        One cell, two labels, stacked. The grid sizes itself to the wider of
        the two whichever is showing, so the swap is a cross-fade in place
        rather than a resize.
      */}
      <span className="grid place-items-center">
        <span
          className={cn(
            'col-start-1 row-start-1 flex items-center gap-2 transition-opacity duration-fast ease-out',
            pending ? 'opacity-0' : 'opacity-100',
          )}
          aria-hidden={pending}
        >
          {label}
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 flex items-center gap-2 transition-opacity duration-fast ease-out',
            pending ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden={!pending}
        >
          {showSpinner ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {pendingLabel}
        </span>
      </span>
    </Button>
  );
}

/**
 * True once `active` has been true for `delay` without interruption.
 *
 * Resets the moment it goes false, so a series of quick saves never
 * accumulates towards showing a spinner none of them needed.
 */
function useSettledDelay(active: boolean, delay: number): boolean {
  const [settled, setSettled] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);

  return settled;
}
