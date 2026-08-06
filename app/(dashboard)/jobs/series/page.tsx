import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/dates';
import { filterFlag, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { listSeries } from '@/lib/series';

export const metadata = { title: 'Recurring jobs' };

/**
 * Recurring series, in one place — spec 6.3.7.
 *
 * The screen exists because a recurrence somebody set up three months ago is
 * otherwise invisible: its jobs look like any others in the list, and nobody
 * can answer "what is still repeating?" without opening them one at a time.
 *
 * What it shows for each series is the next one due, because that is the
 * question people actually arrive with.
 */
export default async function SeriesListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('viewJobs');
  const params = await searchParams;
  const includeFinished = filterFlag(params, 'all');

  const [series, locale] = await Promise.all([
    listSeries({ includeFinished }),
    getLocaleConfig(),
  ]);

  const when = (at: Date) =>
    formatDateTime(at, { timeZone: locale.timeZone, locale: locale.locale });

  return (
    <>
      <PageHeader
        title="Recurring jobs"
        description="Every series still generating work, and what it is due to produce next."
      />

      <p className="mb-4 text-sm text-muted-foreground">
        {includeFinished ? (
          <Link href="/jobs/series" className="underline">
            Hide finished series
          </Link>
        ) : (
          <Link href="/jobs/series?all=true" className="underline">
            Show finished series too
          </Link>
        )}
      </p>

      {series.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="series-empty">
          Nothing repeating. Tick “Book this as a recurring job” on a new
          booking to start a series.
        </p>
      ) : (
        <Table data-testid="series-table">
          <TableHeader>
            <TableRow>
              <TableHead>Series</TableHead>
              <TableHead className="text-right tabular">Jobs</TableHead>
              <TableHead className="text-right tabular">Still to come</TableHead>
              <TableHead>Next</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {series.map((row) => (
              <TableRow key={row.id} data-testid="series-row" data-series-id={row.id}>
                <TableCell className="max-w-md">
                  <Link href={`/jobs/series/${row.id}`} className="underline">
                    {row.label}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular">{row.total}</TableCell>
                <TableCell className="text-right tabular">{row.upcoming}</TableCell>
                <TableCell>
                  {row.nextAt ? (
                    when(row.nextAt)
                  ) : (
                    <span className="text-muted-foreground">Nothing ahead</span>
                  )}
                </TableCell>
                <TableCell>
                  {row.cancelledAt ? (
                    <Badge variant="outline">Ended</Badge>
                  ) : row.cancelled > 0 ? (
                    <Badge variant="outline">{row.cancelled} cancelled</Badge>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
