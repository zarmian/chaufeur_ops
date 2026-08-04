import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  buildListHref,
  paginationSummary,
  type ListParams,
  type SearchParams,
} from '@/lib/list-params';

/**
 * Page controls, plus the count header the spec asks every list to carry.
 *
 * The count is not decoration. "141 clients" answers "did my filter work?"
 * without scrolling, and in Phase 2 the same header carries "N jobs · M
 * unpriced" — the number this whole rebuild exists to make impossible to
 * ignore.
 */
export function Pagination({
  basePath,
  searchParams,
  params,
  total,
  noun,
  extra,
}: {
  basePath: string;
  searchParams: SearchParams;
  params: ListParams;
  total: number;
  /** Singular noun, pluralised with a trailing s. */
  noun: string;
  /** Anything that belongs beside the count — an unpriced tally, say. */
  extra?: React.ReactNode;
}) {
  const { totalPages, from, to, hasPrevious, hasNext } = paginationSummary(
    params,
    total,
  );

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground tabular">
        {total === 0 ? (
          <>No {noun}s match these filters</>
        ) : (
          <>
            Showing {from}–{to} of {total} {noun}
            {total === 1 ? '' : 's'}
          </>
        )}
        {extra ? <> · {extra}</> : null}
      </p>

      {totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            asChild={hasPrevious}
            variant="outline"
            size="sm"
            disabled={!hasPrevious}
          >
            {hasPrevious ? (
              <Link
                href={buildListHref(basePath, searchParams, {
                  page: params.page - 1,
                })}
                rel="prev"
              >
                <ChevronLeft aria-hidden />
                Previous
              </Link>
            ) : (
              <span>
                <ChevronLeft aria-hidden />
                Previous
              </span>
            )}
          </Button>

          <span className="text-sm text-muted-foreground tabular">
            Page {params.page} of {totalPages}
          </span>

          <Button
            asChild={hasNext}
            variant="outline"
            size="sm"
            disabled={!hasNext}
          >
            {hasNext ? (
              <Link
                href={buildListHref(basePath, searchParams, {
                  page: params.page + 1,
                })}
                rel="next"
              >
                Next
                <ChevronRight aria-hidden />
              </Link>
            ) : (
              <span>
                Next
                <ChevronRight aria-hidden />
              </span>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
