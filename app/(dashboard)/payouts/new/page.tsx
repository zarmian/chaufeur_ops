import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toDateOnlyString } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
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

  const fallback = lastFullWeek();
  const from = parseDate(filterValue(query, 'from')) ?? fallback.from;
  const to = parseDate(filterValue(query, 'to')) ?? fallback.to;
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
        <Alert variant="destructive" className="mb-6" data-testid="payout-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form
        method="get"
        action="/payouts/new"
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-muted-foreground">
            From
          </label>
          <Input
            id="from"
            name="from"
            type="date"
            defaultValue={toDateOnlyString(from)}
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-muted-foreground">
            To
          </label>
          <Input id="to" name="to" type="date" defaultValue={toDateOnlyString(to)} />
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
          <p className="text-sm text-muted-foreground">
            {payable.length} driver{payable.length === 1 ? '' : 's'} owed{' '}
            <span className="tabular font-semibold text-foreground">
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
                      <span className="ml-2 text-xs tabular text-muted-foreground">
                        {driver.reference}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {summarise(driver.draft)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-lg font-semibold">
                      {formatGBP(driver.draft.totalPence)}
                    </span>
                    {driver.draft.lines.length > 0 ? (
                      <form method="post" action="/api/payouts">
                        <input type="hidden" name="driverId" value={driver.id} />
                        <input
                          type="hidden"
                          name="from"
                          value={toDateOnlyString(from)}
                        />
                        <input type="hidden" name="to" value={toDateOnlyString(to)} />
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
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
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
  if (draft.jobPence > 0) parts.push(`${formatGBP(draft.jobPence)} in job fees`);
  if (draft.shiftPence > 0) parts.push(`${formatGBP(draft.shiftPence)} in shifts`);
  if (draft.expensePence > 0) {
    parts.push(`${formatGBP(draft.expensePence)} reimbursed`);
  }
  if (parts.length === 0) return 'Nothing payable in this period';
  return `${draft.lines.length} line${draft.lines.length === 1 ? '' : 's'} · ${parts.join(' · ')}`;
}

function parseDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * The week that just ended, Monday to Sunday.
 *
 * Payouts run weekly here, and defaulting to the week in progress would offer
 * to pay work that has not finished happening.
 */
function lastFullWeek(): { from: Date; to: Date } {
  const now = new Date();
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay();

  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  to.setUTCDate(to.getUTCDate() - day);
  to.setUTCHours(23, 59, 59, 999);

  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 6);
  from.setUTCHours(0, 0, 0, 0);

  return { from, to };
}
