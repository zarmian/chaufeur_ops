import * as React from 'react';
import { cn } from '@/lib/utils';

const Table = React.forwardRef<HTMLTableElement, React.ComponentProps<'table'>>(
  ({ className, ...props }, ref) => (
    // The wrapper scrolls rather than the page, so a wide job table never
    // pushes the sidebar off screen — and `scroll-shadow-x` says so, fading
    // an edge only while there is actually something past it.
    <div className="scroll-shadow-x relative w-full overflow-x-auto rounded-lg border">
      <table
        ref={ref}
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.ComponentProps<'thead'>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('bg-muted/50 [&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.ComponentProps<'tbody'>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.ComponentProps<'tr'>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        // The row's own background stays transparent so the wrapper's scroll
        // shadows show through at the edges; the hover tint is painted over
        // it rather than replacing it.
        'border-b transition-colors duration-fast ease-out hover:bg-muted/40 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ComponentProps<'th'>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.ComponentProps<'td'>
>(({ className, ...props }, ref) => (
  // `h-[--table-row-height]` rather than vertical padding: the row keeps a
  // predictable height whether the cell holds one line or a badge, which is
  // what stops a jobs list looking ragged.
  <td
    ref={ref}
    className={cn(
      'h-[--table-row-height] px-3 py-2 align-middle',
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
