import { Label } from '@/components/ui/label';

/**
 * Label, control, hint and error in one place.
 *
 * The error is tied to the input with `aria-describedby` and the input is
 * marked `aria-invalid`, so a screen reader announces the problem rather than
 * just the field name — and so the red border is never the only signal.
 */
export function FormField({
  name,
  label,
  hint,
  errors,
  required,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  errors?: string[];
  required?: boolean;
  children: React.ReactNode;
}) {
  const hasError = Boolean(errors && errors.length > 0);
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </Label>

      {children}

      {hint && !hasError ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}

      {hasError ? (
        <p id={errorId} className="text-xs font-medium text-destructive">
          {errors!.join('. ')}
        </p>
      ) : null}
    </div>
  );
}

/** The props a control needs to be wired to its label, hint and error. */
export function fieldProps(
  name: string,
  errors?: string[],
): {
  id: string;
  name: string;
  'aria-invalid'?: 'true';
  'aria-describedby'?: string;
} {
  const hasError = Boolean(errors && errors.length > 0);
  return {
    id: name,
    name,
    ...(hasError
      ? { 'aria-invalid': 'true' as const, 'aria-describedby': `${name}-error` }
      : {}),
  };
}
