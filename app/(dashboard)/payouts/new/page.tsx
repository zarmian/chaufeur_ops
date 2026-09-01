import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toZonedDateOnlyString, zonedDayRange } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { lastFullPayoutWeek } from '@/lib/payout-period';
import { driversOwedIn } from '@/lib/payout-store';

export const metadata = { title: 'Generate payouts' };

/**
 * Generate drafts for a period — spec 4.5.1.
 *
 * Every driver with work in the period, with what they are owed and what has
 * been left out and why. The exclusions are shown rather than hidden: a
 * driver querying a short payment needs the answer to be visible here, before
 * anybody pays it, not reconstructed afterwards.
 */
export default async function GeneratePayoutsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('editInvoices');
  const query = await searchParams;

  const { timeZone } = await getLocaleConfig();
  const fallback = lastFullPayoutWeek(new Date(), timeZone);

  /*
   * The screen speaks in `YYYY-MM-DD` throughout — the value a date input
   * carries, the value the form posts to `/api/payouts`. Only the
   * interpretation into instants happens here, and it has to be the same
   * interpretation the API uses, or the preview shows one period and the
   * payout covers another.
   */
  const fromValue =
    dateValue(filterValue(query, 'from')) ??
    toZonedDateOnlyString(fallback.from, timeZone);
  const toValue =
    dateValue(filterValue(query, 'to')) ??
    toZonedDateOnlyString(fallback.to, timeZone);

  const from = zonedDayRange(fromValue, timeZone).start;
  // Inclusive, because `driversOwedIn` filters with `lte`.
  const to = new Date(
    zonedDayRange(toValue, timeZone).endExclusive.getTime() - 1,
  );
  const error = filterValue(query, 'payoutError');

  const drivers = await driversOwedIn({ from, to });
  const payable = drivers.filter((driver) => driver.draft.lines.length > 0);
  const totalPence = payable.reduce(
    (total, driver) => total + driver.draft.totalPence,
    0,
  );

  return (
    <>
      <PageHeader
        title="Generate payouts"
        description="Completed jobs, ended shifts and approved expenses that nothing has paid yet."
        actions={
          <Button asChild variant="outline">
            <Link href="/payouts">
              <ArrowLeft aria-hidden />
              Payouts
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert
          variant="destructive"
          className="mb-6"
          data-testid="payout-error"
        >
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form
        method="get"
        action="/payouts/new"
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <div>
          <label
            htmlFor="from"
            className="text-muted-foreground mb-1 block text-xs"
          >
            From
          </label>
          <Input id="from" name="from" type="date" defaultValue={fromValue} />
        </div>
        <div>
          <label
            htmlFor="to"
            className="text-muted-foreground mb-1 block text-xs"
          >
            To
          </label>
          <Input id="to" name="to" type="date" defaultValue={toValue} />
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>

      {drivers.length === 0 ? (
        <EmptyState
          title="Nothing to pay in that period"
          description="Drivers appear here once they have completed work that no payout covers."
        />
      ) : (
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {payable.length} driver{payable.length === 1 ? '' : 's'} owed{' '}
            <span className="tabular text-foreground font-semibold">
              {formatGBP(totalPence)}
            </span>{' '}
            in total.
          </p>

          {drivers.map((driver) => (
            <Card key={driver.id} data-testid={`draft-${driver.id}`}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {driver.name}
                      <span className="tabular text-muted-foreground ml-2 text-xs">
                        {driver.reference}
                      </span>
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {summarise(driver.draft)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-lg font-semibold">
                      {formatGBP(driver.draft.totalPence)}
                    </span>
                    {driver.draft.lines.length > 0 ? (
                      <form method="post" action="/api/payouts">
                        <input
                          type="hidden"
                          name="driverId"
                          value={driver.id}
                        />
                        <input type="hidden" name="from" value={fromValue} />
                        <input type="hidden" name="to" value={toValue} />
                        <Button type="submit">Draft it</Button>
                      </form>
                    ) : (
                      <Badge variant="secondary">Nothing payable</Badge>
                    )}
                  </div>
                </div>

                {driver.draft.excluded.length > 0 ? (
                  <div className="mt-3 rounded-md border border-dashed p-3">
                    <p className="text-xs font-medium">Left out</p>
                    <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                      {driver.draft.excluded.map((item) => (
                        <li key={`${item.reference}-${item.reason}`}>
                          <span className="tabular">{item.reference}</span> —{' '}
                          {item.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function summarise(draft: {
  lines: unknown[];
  jobPence: number;
  shiftPence: number;
  expensePence: number;
}): string {
  const parts: string[] = [];
  if (draft.jobPence > 0)
    parts.push(`${formatGBP(draft.jobPence)} in job fees`);
  if (draft.shiftPence > 0)
    parts.push(`${formatGBP(draft.shiftPence)} in shifts`);
  if (draft.expensePence > 0) {
    parts.push(`${formatGBP(draft.expensePence)} reimbursed`);
  }
  if (parts.length === 0) return 'Nothing payable in this period';
  return `${draft.lines.length} line${draft.lines.length === 1 ? '' : 's'} · ${parts.join(' · ')}`;
}

/** A date input's value, or nothing if it is not one. */
function dateValue(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}
