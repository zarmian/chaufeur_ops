import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import Link from 'next/link';
import { TableHead } from '@/components/ui/table';
import { buildListHref, type SearchParams } from '@/lib/list-params';
import { cn } from '@/lib/utils';

/**
 * A column header that sorts by navigating.
 *
 * Sorting is a link rather than a click handler so it stays in the URL with
 * the filters — the whole view is one shareable address, and sorting works
 * with the browser's back button.
 */
export function SortableHeader({
  sort,
  searchParams,
  align = 'left',
  children,
}: {
  sort: string;
  searchParams: SearchParams;
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  const current = single(searchParams.sort);
  const dir = single(searchParams.dir) === 'desc' ? 'desc' : 'asc';
  const active = current === sort;

  // Clicking the active column flips direction; a new column starts ascending,
  // which is the less surprising default.
  const nextDir = active && dir === 'asc' ? 'desc' : 'asc';
  const href = buildListHref('/jobs', searchParams, { sort, dir: nextDir });

  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Link
        href={href}
        className={cn(
          'inline-flex items-center gap-1 hover:underline',
          active && 'font-semibold text-foreground',
        )}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {children}
        <Icon className="size-3.5 opacity-60" aria-hidden />
      </Link>
    </TableHead>
  );
}

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
