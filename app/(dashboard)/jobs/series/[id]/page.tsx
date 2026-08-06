import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/authz';
import { formatDateTime } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { formatMoney } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { getSeries } from '@/lib/series';

export const metadata = { title: 'Recurring job' };

/**
 * One series and the jobs it produced — spec 6.3.6 and 6.3.7.
 *
 * The jobs are listed rather than summarised because each one is a real
 * booking that may have diverged: a different driver, a renegotiated price, a
 * date somebody moved. A screen that showed only the rule would hide exactly
 * the differences somebody came here to find.
 *
 * Cancelling offers three reaches, and the default is deliberately not "all".
 */
export default async function SeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewJobs');
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const [series, locale] = await Promise.all([getSeries(id), getLocaleConfig()]);
  if (!series) notFound();

  const mayEdit = can(user, 'editJobs');
  const error = filterValue(query, 'seriesError');
  const cancelled = filterValue(query, 'cancelled');

  const when = (at: Date) =>
    formatDateTime(at, { timeZone: locale.timeZone, locale: locale.locale });
  const money = (pence: number | null) =>
    pence === null
      ? '—'
      : formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  // The first job still ahead is the sensible anchor for "this and future":
  // it is what somebody means when they say "stop it from here".
  const now = new Date();
  const nextAhead =
    series.jobs.find(
      (job) =>
        job.scheduledAt >= now && !['CANCELLED', 'COMPLETED'].includes(job.status),
    ) ?? null;

  return (
    <>
      <PageHeader
        title="Recurring job"
        description={series.label}
        actions={
          <Button asChild variant="ghost">
            <Link href="/jobs/series">All series</Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="series-error">
          <AlertTitle>Some jobs were not cancelled</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {cancelled && !error ? (
        <Alert className="mb-6" data-testid="series-message">
          <AlertDescription>
            {cancelled} job{cancelled === '1' ? '' : 's'} cancelled.
          </AlertDescription>
        </Alert>
      ) : null}

      {series.cancelledAt ? (
        <Alert className="mb-6">
          <AlertTitle>This series has ended</AlertTitle>
          <AlertDescription>
            It generates nothing further. The jobs below are unaffected — ending
            a series does not cancel bookings a client is expecting.
          </AlertDescription>
        </Alert>
      ) : null}

      {mayEdit && nextAhead ? (
        <form
          action={`/api/series/${series.id}/actions`}
          method="post"
          className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border p-4"
          data-testid="series-cancel-form"
        >
          <input type="hidden" name="intent" value="cancel" />
          <input type="hidden" name="fromJobId" value={nextAhead.id} />

          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Cancel</span>
            <select
              name="scope"
              defaultValue="future"
              className="flex h-9 w-64 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              data-testid="series-scope"
            >
              <option value="this">{nextAhead.reference} only</option>
              <option value="future">
                {nextAhead.reference} and everything after it
              </option>
              <option value="all">Every job still to come</option>
            </select>
          </label>

          <Button type="submit" variant="destructive">
            Cancel jobs
          </Button>

          <p className="w-full text-xs text-muted-foreground">
            Completed jobs are never touched. Each cancellation is recorded
            against the job individually, with whoever made it.
          </p>
        </form>
      ) : null}

      {mayEdit && !series.cancelledAt ? (
        <form
          action={`/api/series/${series.id}/actions`}
          method="post"
          className="mb-6"
        >
          <input type="hidden" name="intent" value="end" />
          <Button type="submit" variant="outline" data-testid="series-end">
            Stop this series repeating
          </Button>
          <span className="ml-3 text-xs text-muted-foreground">
            Leaves every booking below in place.
          </span>
        </form>
      ) : null}

      <Table data-testid="series-jobs">
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 text-right tabular">#</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Driver</TableHead>
            <TableHead className="text-right tabular">Price</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.jobs.map((job) => (
            <TableRow key={job.id} data-testid="series-job" data-job-id={job.id}>
              <TableCell className="text-right tabular text-muted-foreground">
                {job.seriesIndex ?? '—'}
              </TableCell>
              <TableCell>
                <Link href={`/jobs/${job.id}`} className="underline">
                  {job.reference}
                </Link>
              </TableCell>
              <TableCell>{when(job.scheduledAt)}</TableCell>
              <TableCell>
                {job.driver?.name ?? (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular">
                {money(job.clientPricePence)}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{job.status}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
