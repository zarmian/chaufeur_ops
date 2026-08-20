import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { can } from '@/lib/authz';
import { toDateOnlyString } from '@/lib/dates';
import { loadDispatchDay, loadDispatchRange } from '@/lib/dispatch';
import { filterFlag, filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getSettings } from '@/lib/settings';
import { AttentionPanel } from './attention-panel';
import { DaySection } from './day-section';
import { DispatchBoard } from './dispatch-board';
import { RangeRail } from './range-rail';

export const metadata = { title: 'Dispatch' };

/** How often the board re-reads the day — spec 6.1.9. */
const REFRESH_SECONDS = 30;

/**
 * The dispatch console — spec 6.1, reworked.
 *
 * This page was a single-day Gantt chart and nothing else. It answered "who
 * is busy when, today" and answered it thinly: a ninety-minute block on a
 * nineteen-hour axis had room for a start time and a truncated pickup, the
 * next day was a click away, seven statuses mapped to seven fills with no key
 * anywhere on the page, and an unassigned job forty minutes from its pickup
 * sat in the same column, in the same colour, as one going on Thursday.
 *
 * Four bands now, in the order a dispatcher needs them:
 *
 * 1. **The days.** Today plus the next few, with counts, so "is the rest of
 *    the week covered" stops being a question you have to go and ask.
 * 2. **What needs somebody.** Unassigned work as its pickup nears, and jobs
 *    nobody has started or closed off — read from the driver's own events, so
 *    a driver who is quietly on their way is not chased.
 * 3. **The work**, day by day, as rows that carry the client, the passenger,
 *    the car, the price and how far along the driver is.
 * 4. **The timeline**, per day, behind a disclosure. Still the fastest way to
 *    see who is free at two o'clock, and still where a job is dragged onto a
 *    driver — but one view of the day rather than the whole page.
 *
 * The whole view state is in the URL, as everywhere else in this codebase, so
 * a board can be linked to a colleague exactly as it is being looked at.
 */
export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('dispatch');
  const params = await searchParams;

  const settings = await getSettings();
  const start = parseDay(filterValue(params, 'day'));
  const days = parseDays(filterValue(params, 'days'), settings.dispatchDaysAhead);

  // Which day's timeline is open, if any. A URL parameter rather than local
  // state so it survives the thirty-second refresh — a panel that closed
  // itself every half minute would be worse than not having one.
  const openTimeline = filterValue(params, 'timeline');
  const showEmptyDrivers = filterFlag(params, 'all');

  const range = await loadDispatchRange(start, { days });

  // Only when a timeline is actually open. It is a second set of queries, and
  // most visits to this page never open one.
  const timelineDay =
    openTimeline && range.days.some((day) => day.date === openTimeline)
      ? await loadDispatchDay(new Date(`${openTimeline}T12:00:00.000Z`), {
          includeEmptyDrivers: showEmptyDrivers,
        })
      : null;

  const mayAssign = can(user, 'dispatch');

  // Counted per day for the rail, so a day with something wrong can be found
  // without reading every section.
  const attentionByDay = new Map<string, number>();
  for (const item of range.attention) {
    attentionByDay.set(item.job.day, (attentionByDay.get(item.job.day) ?? 0) + 1);
  }

  const href = (changes: {
    day?: string;
    days?: number;
    timeline?: string | null;
    all?: boolean;
  }) => {
    const next = new URLSearchParams();
    const dayValue = changes.day ?? filterValue(params, 'day');
    if (dayValue) next.set('day', dayValue);

    const dayCount = changes.days ?? days;
    if (dayCount !== settings.dispatchDaysAhead) next.set('days', String(dayCount));

    const timeline =
      changes.timeline === undefined ? openTimeline : changes.timeline;
    if (timeline) next.set('timeline', timeline);

    const all = changes.all ?? showEmptyDrivers;
    if (all) next.set('all', 'true');

    const query = next.toString();
    return query ? `/dispatch?${query}` : '/dispatch';
  };

  return (
    <>
      <PageHeader
        title="Dispatch"
        description={
          range.totals.jobs === 0
            ? 'Nothing booked in this window.'
            : `${range.totals.jobs} ${range.totals.jobs === 1 ? 'job' : 'jobs'} over ${days} ${days === 1 ? 'day' : 'days'}. Refreshes every ${REFRESH_SECONDS} seconds.`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: shift(start, -days), timeline: null })}>
                Back
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: toDateOnlyString(new Date()), timeline: null })}>
                Today
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={href({ day: shift(start, days), timeline: null })}>
                Forward
              </Link>
            </Button>

            {/* The horizon, as a choice. A long weekend and a working week are
                different questions, and neither is the other's default. */}
            {[4, 7].map((option) => (
              <Button
                key={option}
                asChild
                size="sm"
                variant={days === option ? 'default' : 'outline'}
              >
                <Link href={href({ days: option })}>{option} days</Link>
              </Button>
            ))}
          </div>
        }
      />

      <RangeRail days={range.days} attentionByDay={attentionByDay} />

      <AttentionPanel
        items={range.attention}
        drivers={range.drivers}
        mayAssign={mayAssign}
        totalJobs={range.totals.jobs}
        dayCount={days}
      />

      {range.days.map((day) => (
        <DaySection
          key={day.date}
          day={day}
          drivers={range.drivers}
          mayAssign={mayAssign}
          timelineOpen={openTimeline === day.date}
          timelineHref={href({
            timeline: openTimeline === day.date ? null : day.date,
          })}
        >
          {timelineDay && openTimeline === day.date ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {/* Spec 6.1.11 — drivers with nothing on are hidden by
                    default, because forty empty rows is forty rows of
                    nothing. */}
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ all: !showEmptyDrivers })}>
                    {showEmptyDrivers ? 'Busy drivers only' : 'Show all drivers'}
                  </Link>
                </Button>
                <span className="text-xs text-muted-foreground">
                  Drag a job onto a driver to give it to them.
                </span>
              </div>

              <DispatchBoard
                // The board is a Client Component and takes no Prisma types;
                // the instant crosses as an ISO string.
                rows={timelineDay.rows.map((row) => ({
                  ...row,
                  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
                }))}
                unassigned={timelineDay.unassigned}
                hours={timelineDay.hours}
                nowPct={timelineDay.nowPct}
                canAssign={mayAssign}
                refreshSeconds={REFRESH_SECONDS}
              />
            </>
          ) : null}
        </DaySection>
      ))}
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

/**
 * How many days to show. Capped, because the page renders every one.
 *
 * The absent case is checked before the coercion, not after. `Number(null)`
 * and `Number('')` are both `0` rather than `NaN` — so a finiteness check
 * passes, the clamp turns it into 1, and a board configured for four days
 * quietly shows one. The same trap `lib/jobs.ts` documents for blank money
 * fields, in a different disguise.
 */
function parseDays(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(14, Math.floor(parsed)));
}

function shift(from: Date, days: number): string {
  const date = new Date(from);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateOnlyString(date);
}
