import { AlertTriangle, CheckCircle2, Clock, UserX } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  REASON_HINTS,
  REASON_LABELS,
  type AttentionReason,
} from '@/lib/dispatch-attention';
import type { DispatchRange } from '@/lib/dispatch';
import { cn } from '@/lib/utils';
import { AssignPicker } from './assign-picker';

/**
 * What needs somebody, before anything else on the page.
 *
 * The board this replaces listed unassigned work in pickup order and stopped
 * there — so a job going in forty minutes sat in the same column, in the same
 * colour, as one going on Thursday, and a job whose pickup passed an hour ago
 * with nobody having started it did not appear at all.
 *
 * Ordering is the whole point. Worst first, longest-wrong first within that,
 * so working down the panel is working in the right order without anybody
 * having to decide what the right order is.
 */

const ICONS: Record<AttentionReason, typeof Clock> = {
  UNASSIGNED: UserX,
  NOT_STARTED: Clock,
  OVERRUNNING: AlertTriangle,
};

export function AttentionPanel({
  items,
  drivers,
  mayAssign,
  totalJobs,
  dayCount,
}: {
  items: DispatchRange['attention'];
  drivers: DispatchRange['drivers'];
  mayAssign: boolean;
  totalJobs: number;
  dayCount: number;
}) {
  if (items.length === 0) {
    /*
     * "Nothing needs you" is an answer, and it is the one a dispatcher wants
     * most often. A panel that simply disappears when everything is covered
     * makes the reader wonder whether it failed to load — and leaves them
     * checking the board manually, which is the work this was meant to save.
     */
    return (
      <div
        className="mb-6 flex items-center gap-3 rounded-lg border border-success/40 bg-success/5 px-4 py-3"
        data-testid="attention-clear"
      >
        <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
        <p className="text-sm">
          <span className="font-medium">Nothing needs you.</span>{' '}
          <span className="text-muted-foreground">
            {totalJobs} {totalJobs === 1 ? 'job' : 'jobs'} across{' '}
            {dayCount === 1 ? 'today' : `${dayCount} days`}, all covered and
            moving.
          </span>
        </p>
      </div>
    );
  }

  const critical = items.filter((item) => item.severity === 'critical').length;

  return (
    <section className="mb-6" aria-labelledby="attention-heading">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="attention-heading" className="text-sm font-semibold">
          {items.length} {items.length === 1 ? 'job needs' : 'jobs need'} somebody
        </h2>
        {critical > 0 ? (
          <Badge variant="destructive" data-testid="attention-critical">
            {critical} urgent
          </Badge>
        ) : null}
      </div>

      <ul className="divide-y rounded-lg border" data-testid="attention-list">
        {items.map((item) => {
          const Icon = ICONS[item.reason];
          return (
            <li
              key={item.jobId}
              className={cn(
                'flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 text-sm',
                // The tint carries the urgency for anyone scanning; the words
                // carry it for everyone else. Neither is the only signal.
                item.severity === 'critical' ? 'bg-destructive/5' : 'bg-warning/5',
              )}
              data-testid="attention-item"
              data-job-id={item.jobId}
              data-severity={item.severity}
            >
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  item.severity === 'critical'
                    ? 'text-destructive'
                    : 'text-warning-foreground',
                )}
                aria-hidden
              />

              <div className="min-w-40 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Link
                    href={`/jobs/${item.jobId}`}
                    className="font-medium hover:underline"
                  >
                    {item.reference}
                  </Link>
                  <span className="tabular text-muted-foreground">
                    {item.job.startLabel}
                  </span>
                  <span className="text-muted-foreground">
                    {item.job.pickupText} → {item.job.dropoffText}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {REASON_LABELS[item.reason]}
                  </span>
                  {' · '}
                  {/* The clock, said out loud. "40m ago" is what turns a flag
                      into a decision about whether to ring somebody. */}
                  <span className="tabular">{item.when}</span>
                  {' · '}
                  {REASON_HINTS[item.reason]}
                  {item.job.driverName ? ` — ${item.job.driverName}` : ''}
                </p>
              </div>

              {item.reason === 'UNASSIGNED' && mayAssign ? (
                <AssignPicker jobId={item.jobId} drivers={drivers} />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
