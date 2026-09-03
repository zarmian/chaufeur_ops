/**
 * Narrowing a long list of options down to the ones somebody means.
 *
 * A fleet of nearly two hundred owner-drivers makes a `<select>` a scroll
 * rather than a choice, and the same is true of the vehicle list beside it.
 * The fix is a search box above the select rather than a replacement for it:
 * the native picker stays, so the keyboard, the operating system's own
 * behaviour and every existing form post keep working, and the list it opens
 * is three names instead of a hundred and ninety-five.
 *
 * Pure, because the two rules that matter are easy to get subtly wrong and
 * both are invisible until they bite.
 */

export interface FilterableOption {
  value: string;
  label: string;
}

/** Letters and digits only, so "O'Brien" and "OBrien" are the same search. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The options worth showing for what has been typed.
 *
 * **The current selection always survives the filter.** A `<select>` whose
 * selected `<option>` is removed from the DOM silently loses its value, so a
 * dispatcher who picks a driver and then types in the search box would submit
 * a job with nobody on it — and the form would look exactly as it did a moment
 * earlier. That is the whole reason this is a function with a test rather than
 * a `.filter()` written inline.
 *
 * Matching is on the label, in the order the caller supplied, because that
 * order is already meaningful — drivers by name, vehicles by registration.
 */
export function filterOptions(
  options: FilterableOption[],
  query: string,
  selected?: string,
): FilterableOption[] {
  const needle = squash(query);
  if (!needle) return options;

  return options.filter(
    (option) =>
      squash(option.label).includes(needle) ||
      // Kept even when it does not match, so the selection cannot be dropped
      // out from under the operator.
      (Boolean(selected) && option.value === selected),
  );
}

/**
 * Whether a list is long enough that a search box earns its space.
 *
 * A four-vehicle install should not be given a search box for four vehicles;
 * it is one more thing on the screen and nothing to find. The threshold is
 * deliberately low rather than clever — the moment a list stops fitting in a
 * glance is roughly where a filter starts paying.
 */
export const FILTER_WORTH_IT_FROM = 8;

export function worthFiltering(count: number): boolean {
  return count >= FILTER_WORTH_IT_FROM;
}
