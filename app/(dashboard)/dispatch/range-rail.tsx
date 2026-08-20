import Link from 'next/link';
import type { DispatchDaySummary } from '@/lib/dispatch';
import { cn } from '@/lib/utils';

/**
 * The days, at a glance.
 *
 * The question this answers is the one the old board could not: *is the rest
 * of the week covered*. One day at a time meant Thursday was three clicks and
 * a memory away, so nobody looked until Thursday.
 *
 * Counts rather than a preview of the work. A chip has room for a number, and
 * a number is what the decision turns on — "fifteen jobs, six to fill" sends
 * somebody to Monday, and no amount of miniature blocks would say it faster.
 */
export function RangeRail({
  days,
  attentionByDay,
}: {
  days: DispatchDaySummary[];
  /** How many flagged jobs fall on each date. */
  attentionByDay: Map<string, number>;
}) {
  return (
    <nav
      className="mb-6 flex flex-wrap gap-2"
      aria-label="Days on this board"
      data-testid="range-rail"
    >
      {days.map((day) => {
        const needs = attentionByDay.get(day.date) ?? 0;

        return (
          <Link
            key={day.date}
            href={`#day-${day.date}`}
            className={cn(
              'press-surface min-w-36 flex-1 rounded-lg border bg-card p-3 shadow-chip hover:bg-accent/40 hover:shadow-panel',
              // A day with something wrong is worth finding without reading
              // the numbers. The border does that; the badge below says what.
              needs > 0 && 'border-warning/60',
            )}
            data-testid="rail-day"
            data-date={day.date}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{day.label}</span>
              <span className="text-xs tabular text-muted-foreground">
                {day.counts.jobs}
              </span>
            </span>

            <span className="mt-1 block text-xs text-muted-foreground">
              {day.counts.jobs === 0 ? (
                'Nothing booked'
              ) : needs > 0 ? (
                <span className="font-medium text-warning-foreground">
                  {needs} {needs === 1 ? 'needs' : 'need'} somebody
                </span>
              ) : day.counts.unassigned > 0 ? (
                `${day.counts.unassigned} still to fill`
              ) : (
                'All covered'
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
