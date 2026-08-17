'use client';

import { motion } from 'motion/react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SPRING } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * The outcome of the thing that just happened.
 *
 * Every one of these arrives the same way: an action posts, the server
 * redirects back with the result on the query string, and the page renders
 * again with a message on it. Which means the message is *already there* when
 * the page paints — there is no transition from "no message" to "message",
 * just a page that looks slightly different from the one before it, several
 * hundred milliseconds and a full navigation later.
 *
 * That is the problem this solves. Somebody who has just clicked "Assign to
 * twelve jobs" and watched the page reload has no way to tell the new banner
 * from furniture that was always there. Arriving under its own power is what
 * marks it as *new*, and it is the only cue available, because nothing about
 * a re-rendered page says which parts changed.
 *
 * `role="status"` rather than `alert` for the ordinary case: a status is
 * announced when the screen reader next pauses, an alert interrupts. Being
 * interrupted to be told a save worked is worse than being told a moment
 * later. A destructive outcome takes `role="alert"` through the `Alert`
 * component's own default.
 */
export function Notice({
  children,
  variant = 'default',
  className,
  ...props
}: {
  children: React.ReactNode;
  variant?: 'default' | 'destructive' | 'warning';
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING.snappy}
      // Announced politely, and only once — the wrapper carries the live
      // region so the message inside can change without the whole thing
      // being re-announced from scratch.
      role={variant === 'destructive' ? undefined : 'status'}
      aria-live={variant === 'destructive' ? undefined : 'polite'}
      {...props}
    >
      <Alert variant={variant} className={cn('mb-4', className)}>
        <AlertDescription>{children}</AlertDescription>
      </Alert>
    </motion.div>
  );
}
