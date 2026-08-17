import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A styled native `<select>`.
 *
 * Native on purpose: filter bars submit as plain GET forms, so a list stays
 * filterable with JavaScript unavailable or still loading, and the operating
 * system's own picker is faster to use on a laptop than any recreation of it.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<'select'>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      // `text-foreground` is explicit rather than inherited: Windows renders
      // a native select's text with the system colour in dark mode, which on
      // a dark surface is dark on dark.
      'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-chip transition-colors duration-fast ease-out',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-destructive',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export { Select };
