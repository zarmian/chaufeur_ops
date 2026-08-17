import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * `press` rather than `transition-colors`.
 *
 * The old base acknowledged a click on release, because a colour change on
 * `:hover` is not feedback for the finger going down — on a touchscreen there
 * is no hover at all, so a dispatcher tapping a status button got nothing
 * until the request came back. `.press` (see `app/globals.css`) puts the
 * response on `:active`, which fires on pointer-down, and drops the transform
 * again under `prefers-reduced-motion` while keeping the colour change.
 */
const buttonVariants = cva(
  'press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Hover and press come from the brand palette rather than from an
        // opacity on the base. `lib/theme.ts` has been writing these two
        // tokens from branding settings all along; this is the first thing to
        // read them, so a configured primary now reaches all three states
        // instead of only the resting one.
        default:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground active:bg-accent/70',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/60',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-accent/70',
        // Text in a sentence. Scaling a word away from the words around it
        // reads as a rendering fault rather than as a press, so the utility
        // cancels the transform — it lands in a later layer than `.press`.
        link: 'text-primary underline-offset-4 hover:underline active:scale-100',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
