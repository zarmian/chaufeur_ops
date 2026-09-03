'use client';

import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  filterOptions,
  worthFiltering,
  type FilterableOption,
} from '@/lib/option-filter';

/**
 * A native `<select>` with a search box above it.
 *
 * Nearly two hundred owner-drivers makes the driver picker a scroll rather
 * than a choice, and the vehicle list beside it is the same. This is the
 * smallest thing that fixes that.
 *
 * **A filter over the select, not a replacement for it.** A custom combobox
 * would have meant re-implementing keyboard handling, the mobile picker and
 * the whole form-post contract — and the native control is genuinely faster
 * on a laptop, which is where dispatch works. Typing "mar" leaves three
 * options in the list the operating system opens; everything else about the
 * control is exactly as it was.
 *
 * The search box is not part of the form. It has no `name`, so nothing about
 * it is submitted, and with JavaScript unavailable the select still holds
 * every option and still works.
 */
export function FilteredSelect({
  options,
  value,
  onChange,
  emptyLabel,
  searchLabel,
  ...select
}: {
  options: FilterableOption[];
  value: string;
  onChange: (value: string) => void;
  /** The always-present first option — "Unassigned", "No vehicle". */
  emptyLabel: string;
  /** What the search box is for, announced rather than only placeheld. */
  searchLabel: string;
} & Omit<
  React.ComponentProps<'select'>,
  'value' | 'onChange' | 'children'
>) {
  const searchId = useId();
  const [query, setQuery] = useState('');

  const showSearch = worthFiltering(options.length);
  const shown = showSearch ? filterOptions(options, query, value) : options;

  return (
    <div className="space-y-1.5">
      {showSearch ? (
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-2.5 left-2 size-3.5"
            aria-hidden
          />
          <Input
            id={searchId}
            type="search"
            /*
             * No `name`. This box narrows what is on screen and is not part of
             * the booking — a stray `q=mar` in the posted form would be a
             * field the server has to know to ignore.
             */
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="h-8 pl-7 text-sm"
            // Enter in a search box should filter, not submit the booking.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </div>
      ) : null}

      <Select
        {...select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {shown.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>

      {/*
        Said out loud when a search has hidden things, because a select that
        silently holds three of a hundred and ninety-five options looks like a
        system that has lost the rest.
      */}
      {showSearch && query.trim() !== '' ? (
        <p className="text-muted-foreground text-xs" role="status">
          {shown.length === 0
            ? 'Nothing matches — clear the search to see the full list.'
            : `Showing ${shown.length} of ${options.length}.`}
        </p>
      ) : null}
    </div>
  );
}
