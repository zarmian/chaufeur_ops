'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import type { PanInfo } from 'motion/react';
import * as React from 'react';
import { project, SPRING } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * A panel that slides in from an edge, and can be thrown back out.
 *
 * What this replaces: the navigation drawer was `{open ? <aside/> : null}`.
 * Rendered that way it had no exit at all — closing unmounted it in a single
 * frame, so it vanished rather than left. It could not be interrupted, it
 * could not be reversed, and it could not be touched: the only way to close
 * it was to find the X or the backdrop and click.
 *
 * Three things make the difference:
 *
 * 1. **It tracks the finger 1:1.** Motion's `drag` uses pointer capture, so
 *    the panel stays under the pointer even once the pointer has left it, and
 *    it moves from where it was grabbed rather than jumping to the centre.
 * 2. **It is interruptible.** Springs animate from the current on-screen
 *    value, so grabbing a panel mid-close catches it where it is and carries
 *    on from there. A CSS transition would restart from its target and jump.
 * 3. **The release decides by momentum, not by position.** A short flick past
 *    the threshold closes it, exactly as a flick of a scroll view keeps
 *    going — `project()` works out where the gesture was heading, and that is
 *    what is asked, not where the finger happened to stop.
 *
 * Radix supplies the parts that are easy to get wrong and invisible when they
 * are: focus trap, restore-focus-on-close, Escape, `aria-modal`, and the
 * inert background. `forceMount` hands mounting to `AnimatePresence`, so the
 * exit animation gets to finish before the panel goes.
 */

type Side = 'left' | 'right';

/** Past this much of its own width, released, the panel is being dismissed. */
const DISMISS_FRACTION = 0.5;

/**
 * Further than any hand will drag on a tablet.
 *
 * The closed-ward constraint is deliberately not the panel's width: a drag
 * that hits a wall halfway to the dismiss threshold cannot express "I mean
 * it". Open-ward is where the constraint matters, and that is `0`.
 */
const FAR = 2000;

export function Sheet({
  open,
  onOpenChange,
  side = 'left',
  title,
  titleHidden = false,
  description,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: Side;
  /** Required by the dialog role — a modal with no name is unusable blind. */
  title: string;
  /** Set when the panel's own content already says what it is. */
  titleHidden?: boolean;
  description?: string;
  className?: string;
  children: React.ReactNode;
}) {
  // The panel's offset in px. A motion value rather than React state, so a
  // drag does not re-render the navigation on every pointer move.
  const x = useMotionValue(0);
  const panel = React.useRef<HTMLDivElement>(null);

  /** −1 when closing means moving left. */
  const closedWard = side === 'left' ? -1 : 1;

  /*
   * The scrim follows the panel rather than fading on its own clock.
   *
   * Feedback has to be continuous *during* a gesture, not only at the end. A
   * backdrop that holds full opacity until the drag completes tells you
   * nothing while you are still deciding — half-dragged should look half
   * closed, so that letting go is a prediction rather than a gamble.
   *
   * The width is read from the ref on each update rather than captured, so
   * the first measurement after mount is picked up without re-subscribing.
   */
  const scrimOpacity = useTransform(x, (value) => {
    const width = panel.current?.offsetWidth ?? 0;
    if (width <= 0) return 1;
    return Math.max(0, Math.min(1, 1 - Math.abs(value) / width));
  });

  function handleDragEnd(_event: unknown, info: PanInfo) {
    const width = panel.current?.offsetWidth ?? 0;
    // Positive means "heading closed", whichever edge this panel lives on.
    const velocity = info.velocity.x * closedWard;
    const travelled = Math.abs(x.get());

    // Where the panel would come to rest if it were let go on a frictionless
    // surface. Comparing *that* against the threshold is what lets a small
    // fast flick close the drawer while a slow drag of the same distance
    // leaves it open — the hand said something different in each case.
    const projected = travelled + Math.max(0, project(velocity));

    if (projected > width * DISMISS_FRACTION) {
      onOpenChange(false);
      return;
    }

    // Otherwise `dragSnapToOrigin` takes it home, carrying the velocity it
    // was released with, so there is no seam between the drag and the spring.
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal key="sheet" forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-scrim"
                style={{ opacity: scrimOpacity }}
                exit={{ opacity: 0 }}
                transition={SPRING.snappy}
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                ref={panel}
                className={cn(
                  'material-thick fixed inset-y-0 z-40 flex w-64 flex-col shadow-sheet',
                  side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
                  className,
                )}
                style={{ x }}
                // Percentages of its own width, so the panel's size can change
                // without the animation having to be told.
                initial={{ x: `${closedWard * 100}%` }}
                animate={{ x: 0 }}
                // It leaves towards the edge it came from. A panel that
                // arrives from the left and departs downwards reads as two
                // unrelated things.
                exit={{ x: `${closedWard * 100}%` }}
                transition={SPRING.sheet}
                drag="x"
                dragConstraints={
                  side === 'left'
                    ? { left: -FAR, right: 0 }
                    : { left: 0, right: FAR }
                }
                // Resistance rather than a wall at the open end: the panel
                // still answers the hand, it just has nowhere further to go.
                dragElastic={{
                  left: side === 'left' ? 1 : 0.12,
                  right: side === 'left' ? 0.12 : 1,
                  top: 0,
                  bottom: 0,
                }}
                dragSnapToOrigin
                onDragEnd={handleDragEnd}
              >
                <DialogPrimitive.Title
                  className={cn(
                    titleHidden ? 'sr-only' : 'px-5 py-3 text-lg font-semibold',
                  )}
                >
                  {title}
                </DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="sr-only">
                    {description}
                  </DialogPrimitive.Description>
                ) : null}
                {children}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

export const SheetClose = DialogPrimitive.Close;
