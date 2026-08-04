import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE } from './api';
import {
  buildListHref,
  filterFlag,
  filterValue,
  paginationSummary,
  parseListParams,
} from './list-params';

describe('parseListParams', () => {
  it('defaults to the first page', () => {
    const params = parseListParams({});
    expect(params.page).toBe(1);
    expect(params.skip).toBe(0);
  });

  it('computes skip from page and size', () => {
    expect(parseListParams({ page: '3', pageSize: '20' }).skip).toBe(40);
  });

  it('caps the page size so no caller can ask for the whole table', () => {
    // The legacy Overview rendered 704 rows at once.
    expect(parseListParams({ pageSize: '5000' }).pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('falls back on nonsense rather than erroring', () => {
    expect(parseListParams({ page: 'abc' }).page).toBe(1);
    expect(parseListParams({ page: '-4' }).page).toBe(1);
  });

  it('treats a blank search as no search', () => {
    expect(parseListParams({ q: '   ' }).q).toBeNull();
    expect(parseListParams({ q: 'heathrow' }).q).toBe('heathrow');
  });

  it('takes the first value when a key repeats', () => {
    expect(parseListParams({ q: ['first', 'second'] }).q).toBe('first');
  });

  it('applies the caller default sort and direction', () => {
    const params = parseListParams({}, { defaultSort: 'name', defaultDir: 'desc' });
    expect(params.sort).toBe('name');
    expect(params.dir).toBe('desc');
  });

  it('only accepts asc or desc', () => {
    expect(parseListParams({ dir: 'sideways' }).dir).toBe('asc');
    expect(parseListParams({ dir: 'desc' }).dir).toBe('desc');
  });
});

describe('filterValue', () => {
  it('reads a filter', () => {
    expect(filterValue({ status: 'ACTIVE' }, 'status')).toBe('ACTIVE');
  });

  it('treats "all" and blank as no filter', () => {
    expect(filterValue({ status: 'all' }, 'status')).toBeNull();
    expect(filterValue({ status: '' }, 'status')).toBeNull();
    expect(filterValue({}, 'status')).toBeNull();
  });
});

describe('filterFlag', () => {
  it('is only true for the literal string', () => {
    expect(filterFlag({ archived: 'true' }, 'archived')).toBe(true);
    expect(filterFlag({ archived: 'false' }, 'archived')).toBe(false);
    expect(filterFlag({}, 'archived')).toBe(false);
  });
});

describe('buildListHref', () => {
  it('keeps existing parameters', () => {
    expect(buildListHref('/drivers', { q: 'nasir', status: 'ACTIVE' }, {})).toBe(
      '/drivers?q=nasir&status=ACTIVE',
    );
  });

  it('returns to page 1 when a filter changes', () => {
    // Staying on page 7 of a narrower result set reads as lost data.
    expect(
      buildListHref('/drivers', { page: '7', q: 'nasir' }, { status: 'ACTIVE' }),
    ).toBe('/drivers?q=nasir&status=ACTIVE');
  });

  it('keeps the page when the page is what changed', () => {
    expect(buildListHref('/drivers', { q: 'nasir' }, { page: 3 })).toBe(
      '/drivers?q=nasir&page=3',
    );
  });

  it('removes a parameter set to null or false', () => {
    expect(buildListHref('/drivers', { q: 'nasir' }, { q: null })).toBe(
      '/drivers',
    );
    expect(
      buildListHref('/clients', { archived: 'true' }, { archived: false }),
    ).toBe('/clients');
  });

  it('drops the question mark when nothing is left', () => {
    expect(buildListHref('/drivers', {}, {})).toBe('/drivers');
  });
});

describe('paginationSummary', () => {
  it('describes the current window', () => {
    const summary = paginationSummary(parseListParams({ pageSize: '50' }), 141);
    expect(summary).toMatchObject({
      totalPages: 3,
      from: 1,
      to: 50,
      hasPrevious: false,
      hasNext: true,
    });
  });

  it('handles a partial last page', () => {
    const summary = paginationSummary(
      parseListParams({ page: '3', pageSize: '50' }),
      141,
    );
    expect(summary).toMatchObject({ from: 101, to: 141, hasNext: false });
  });

  it('handles an empty result set without claiming page 0', () => {
    const summary = paginationSummary(parseListParams({}), 0);
    expect(summary).toMatchObject({
      totalPages: 1,
      from: 0,
      to: 0,
      hasPrevious: false,
      hasNext: false,
    });
  });
});
