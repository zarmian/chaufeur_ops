import { Inbox } from 'lucide-react';

/**
 * What a list shows when it has nothing.
 *
 * Distinguishes "you have not added any yet" from "your filter matched
 * nothing", because the first needs a create button and the second needs the
 * filter clearing — and showing the wrong one sends people looking for data
 * that was never there.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <Inbox className="size-6 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        {description ? (
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
