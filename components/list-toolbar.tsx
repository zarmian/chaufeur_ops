import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { SearchParams } from '@/lib/list-params';

export interface FilterDefinition {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  /** Label for the "no filter" option. */
  allLabel?: string;
}

/**
 * Search and filters as a plain GET form.
 *
 * Submitting navigates, which puts the whole view state in the URL — so a
 * filtered list can be bookmarked, shared with a colleague, or reloaded
 * without losing what you were looking at. The legacy Overview kept its
 * search in memory and lost it on every refresh.
 */
export function ListToolbar({
  action,
  searchParams,
  searchPlaceholder = 'Search',
  filters = [],
  children,
}: {
  action: string;
  searchParams: SearchParams;
  searchPlaceholder?: string;
  filters?: FilterDefinition[];
  children?: React.ReactNode;
}) {
  const value = (key: string) => {
    const raw = searchParams[key];
    return (Array.isArray(raw) ? raw[0] : raw) ?? '';
  };

  return (
    <form
      action={action}
      method="get"
      className="mb-4 flex flex-wrap items-end gap-3"
    >
      <div className="min-w-56 flex-1">
        <label htmlFor="q" className="sr-only">
          {searchPlaceholder}
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={value('q')}
            placeholder={searchPlaceholder}
            className="pl-8"
          />
        </div>
      </div>

      {filters.map((filter) => (
        <div key={filter.name} className="w-44">
          <label
            htmlFor={filter.name}
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {filter.label}
          </label>
          <Select
            id={filter.name}
            name={filter.name}
            defaultValue={value(filter.name)}
          >
            <option value="">{filter.allLabel ?? 'All'}</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      ))}

      {children}

      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}
