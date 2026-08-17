'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A modal task.
 *
 * This exists to replace `window.confirm()`, which the destructive actions
 * used to call. The native dialog cannot be styled, cannot say which record
 * it is about in anything but plain text, renders at the top of the browser
 * window far from the button that summoned it, and — the part that matters —
 * blocks the main thread, so the page behind it is frozen rather than merely
 * dimmed.
 *
 * Two rules from the design guidance shape what is here. **Dim to focus**: a
 * modal is a task that has to be finished or abandoned, so it comes with a
 * scrim and the page behind it recedes; that is what distinguishes it from a
 * panel you can ignore. And **enter and exit along the same path**: the
 * easings are the mirrored pair from `app/globals.css`, so it leaves the way
 * it arrived rather than taking an unrelated route out.
 *
 * Use it sparingly. A confirmation on everything trains people to click
 * through confirmations, which costs exactly the protection it was added for.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-scrim backdrop-blur-[2px]',
      'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-base',
      'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
        'material-thick rounded-lg border p-6 shadow-sheet',
        // Arriving as a material rather than as a picture of one: the blur
        // and the scale come up together, so it reads as a surface settling
        // into place instead of an image being faded in.
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        'data-[state=open]:duration-base data-[state=open]:ease-out',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        'data-[state=closed]:duration-fast data-[state=closed]:ease-in',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="press absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Close"
      >
        <X className="size-4" aria-hidden />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mb-4 space-y-1.5 pr-6', className)} {...props} />;
}

/**
 * The buttons, laid out so the safe one is where the hand already is.
 *
 * Reversed on a narrow screen so the primary action is the lower of the two,
 * nearer the thumb, rather than the one at the top of a stack.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
};
