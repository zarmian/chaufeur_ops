import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { can } from '@/lib/authz';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { loadDispatchDay } from '@/lib/dispatch';
import { filterFlag, filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { DispatchBoard } from './dispatch-board';

export const metadata = { title: 'Dispatch' };

/** How often the board re-reads the day — spec 6.1.9. */
const REFRESH_SECONDS = 30;

export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('dispatch');
  const params = await searchParams;

  const locale = await getLocaleConfig();
  const day = parseDay(filterValue(params, 'day'));
  const showEmpty = filterFlag(params, 'all');

  const dispatch = await loadDispatchDay(day, { includeEmptyDrivers: showEmpty });

  const href = (changes: { day?: string; all?: boolean }) => {
    const next = new URLSearchParams();
    const dayValue = changes.day ?? filterValue(params, 'day');
    if (dayValue) next.set('day', dayValue);
    const all = changes.all ?? showEmpty;
    if (all) next.set('all', 'true');
    const query = next.toString();
    return query ? `/dispatch?${query}` : '/dispatch';
  };

  return (
    <>
      <PageHeader
        title="Dispatch"
        description={`${formatDate(day, locale)} — the day's work, by driver.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: shift(day, -1) })}>Previous</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: toDateOnlyString(new Date()) })}>Today</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: shift(new Date(), 1) })}>Tomorrow</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: shift(day, 1) })}>Next</Link>
            </Button>
            {/* Spec 6.1.11 — drivers with nothing on are hidden by default,
                because forty empty rows is forty rows of nothing. */}
            <Button asChild variant={showEmpty ? 'default' : 'outline'} size="sm">
              <Link href={href({ all: !showEmpty })}>
                {showEmpty ? 'Busy drivers only' : 'Show all drivers'}
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{dispatch.counts.jobs} jobs</Badge>
        {dispatch.counts.unassigned > 0 ? (
          <Badge variant="warning">{dispatch.counts.unassigned} unassigned</Badge>
        ) : null}
        {dispatch.counts.conflicts > 0 ? (
          <Badge variant="destructive">{dispatch.counts.conflicts} clashing</Badge>
        ) : null}
        {dispatch.counts.unpriced > 0 ? (
          <Badge variant="warning">{dispatch.counts.unpriced} with no price</Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Refreshes every {REFRESH_SECONDS} seconds.
        </span>
      </div>

      <DispatchBoard
        // The board is a Client Component and takes no Prisma types; the
        // instant crosses as an ISO string.
        rows={dispatch.rows.map((row) => ({
          ...row,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        }))}
        unassigned={dispatch.unassigned}
        hours={dispatch.hours}
        nowPct={dispatch.nowPct}
        canAssign={can(user, 'dispatch')}
        refreshSeconds={REFRESH_SECONDS}
      />
    </>
  );
}

/** `YYYY-MM-DD` from the URL, or today. */
function parseDay(value: string | null): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Midday, so the instant lands inside the intended local day whichever
    // side of a daylight-saving boundary it falls.
    return new Date(`${value}T12:00:00.000Z`);
  }
  return new Date();
}

function shift(from: Date, days: number): string {
  const date = new Date(from);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateOnlyString(date);
}
