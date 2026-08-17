'use client';

import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * "Are you sure", asked properly.
 *
 * These replace `window.confirm()`. What was wrong with it was not that it is
 * ugly — it is that it is a different application talking. The native dialog
 * appears at the top of the browser window rather than near the button that
 * summoned it, it renders in the operating system's own theme with no
 * relationship to the page, its buttons say "OK" and "Cancel" whatever the
 * question is, and it blocks the main thread, so the page behind it is frozen
 * rather than merely waiting.
 *
 * The last one matters most on a page like a rental, where "Cancel this hire"
 * and "Cancel" in a dialog are two different cancels. A dialog that can name
 * its own buttons — "Stop the contract" against "Leave it running" — is a
 * question somebody can answer without re-reading it.
 *
 * Confirmation is still a cost, so it is reserved for what the design guidance
 * reserves it for: destructive actions that are not trivially reversible.
 * Everything else commits on the click and offers a way back instead. A
 * confirmation on everything just teaches people to confirm everything.
 */

interface ConfirmProps {
  /** The button that opens the question. */
  label: React.ReactNode;
  title: string;
  description: React.ReactNode;
  /** Names the action, never "OK" — "Delete WL-0042", "Stop the contract". */
  confirmLabel: string;
  /** Names the way out, never "Cancel" where the action is also a cancel. */
  cancelLabel?: string;
  variant?: ButtonProps['variant'];
  className?: string;
  disabled?: boolean;
}

/**
 * Confirm, then submit a form somewhere else on the page.
 *
 * The dialog is portalled to the end of the document, so a `type="submit"`
 * inside it is outside the form it means to submit. The `form` attribute is
 * what bridges that — it takes an id and works across the whole document,
 * which is exactly the case it exists for.
 */
export function ConfirmSubmit({
  formId,
  label,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'destructive',
  className,
  disabled,
}: ConfirmProps & { formId: string }) {
  return (
    <ConfirmShell
      label={label}
      title={title}
      description={description}
      cancelLabel={cancelLabel}
      variant={variant}
      className={className}
      disabled={disabled}
      confirm={
        <Button type="submit" form={formId} variant={variant}>
          {confirmLabel}
        </Button>
      }
    />
  );
}

/** Confirm, then run something. For actions that are not a form post. */
export function ConfirmAction({
  onConfirm,
  label,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'destructive',
  className,
  disabled,
}: ConfirmProps & { onConfirm: () => void }) {
  const [open, setOpen] = React.useState(false);

  return (
    <ConfirmShell
      open={open}
      onOpenChange={setOpen}
      label={label}
      title={title}
      description={description}
      cancelLabel={cancelLabel}
      variant={variant}
      className={className}
      disabled={disabled}
      confirm={
        <Button
          type="button"
          variant={variant}
          onClick={() => {
            setOpen(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      }
    />
  );
}

function ConfirmShell({
  open,
  onOpenChange,
  label,
  title,
  description,
  cancelLabel,
  variant,
  className,
  disabled,
  confirm,
}: Omit<ConfirmProps, 'confirmLabel'> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  confirm: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {/* Explicitly `type="button"`: an unqualified button inside a form
            submits it, which would do the thing before asking. */}
        <Button
          type="button"
          variant={variant}
          className={className}
          disabled={disabled}
        >
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {/* The safe option first in the DOM, so it is where focus and the
              Escape key already agree the way out is. */}
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {cancelLabel}
            </Button>
          </DialogClose>
          {confirm}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
