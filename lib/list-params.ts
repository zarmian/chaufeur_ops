import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './api';

/**
 * Filter and pagination state, parsed from the URL.
 *
 * Every list in this system is server-paginated and keeps its state in the
 * query string. Two reasons, both learned from the legacy system: it rendered
 * 704 rows at once and got slower every week, and a filtered view could not
 * be sent to a colleague because the URL never changed.
 */

export interface ListParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  q: string | null;
  sort: string | null;
  dir: 'asc' | 'desc';
}

export type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function parseListParams(
  searchParams: SearchParams,
  options: { defaultSort?: string; defaultDir?: 'asc' | 'desc' } = {},
): ListParams {
  const rawPage = Number(first(searchParams.page) ?? 1);
  const rawSize = Number(first(searchParams.pageSize) ?? DEFAULT_PAGE_SIZE);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(Math.floor(rawSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const q = first(searchParams.q)?.trim() || null;
  const sort = first(searchParams.sort) ?? options.defaultSort ?? null;
  const dir = first(searchParams.dir) === 'desc' ? 'desc' : options.defaultDir ?? 'asc';

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, q, sort, dir };
}

/** Read a single filter value, treating blank and `all` as "no filter". */
export function filterValue(
  searchParams: SearchParams,
  key: string,
): string | null {
  const value = first(searchParams[key]);
  if (!value || value === 'all') return null;
  return value;
}

export function filterFlag(searchParams: SearchParams, key: string): boolean {
  return first(searchParams[key]) === 'true';
}

/**
 * Build a URL that changes some parameters and keeps the rest.
 *
 * Changing a filter always returns to page 1 — staying on page 7 of a
 * narrower result set is how a user concludes the system has lost their data.
 */
export function buildListHref(
  basePath: string,
  current: SearchParams,
  changes: Record<string, string | number | boolean | null>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(current)) {
    const single = first(value);
    if (single) params.set(key, single);
  }

  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '' || value === false) params.delete(key);
    else params.set(key, String(value));
  }

  if (!('page' in changes)) params.delete('page');

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** `"3 of 141"`-style summary, and whether the arrows should be live. */
export function paginationSummary(params: ListParams, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const from = total === 0 ? 0 : params.skip + 1;
  const to = Math.min(params.skip + params.pageSize, total);
  return {
    totalPages,
    from,
    to,
    hasPrevious: params.page > 1,
    hasNext: params.page < totalPages,
  };
}
