import { MILESTONES, type JobProgress } from '@/lib/job-progress';
import { cn } from '@/lib/utils';

/**
 * How far along a job is, as six pips.
 *
 * A word alone ("On the way") says where the driver is but not how much is
 * left; a bar alone says how much is left but not what is happening. Six
 * discrete steps say both at a glance, and because the steps are the same six
 * on every row, a column of them can be scanned down rather than read across.
 *
 * The label beside them is what a screen reader gets — the pips are marked
 * `aria-hidden`, because "filled circle, filled circle, empty circle" is not
 * a description of anything.
 */
export function ProgressPips({
  progress,
  label,
  waitingFor,
}: {
  progress: JobProgress;
  label: string;
  /** "12m" when it has been sitting at this step a while, else null. */
  waitingFor: string | null;
}) {
  const reached = progress.milestone
    ? MILESTONES.indexOf(progress.milestone) + 1
    : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-0.5" aria-hidden>
        {MILESTONES.map((milestone, index) => (
          <span
            key={milestone}
            className={cn(
              'h-1.5 w-2 rounded-full transition-colors duration-fast ease-out',
              index < reached ? 'bg-primary' : 'bg-muted',
            )}
          />
        ))}
      </span>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {label}
        {/*
          The wait-time meter, running. The gap between arriving and the
          passenger getting in is billable above a free allowance, so a driver
          who has been at the kerb twenty minutes is money as well as a
          question — and it is the one number here nobody can see anywhere
          else until the job is finished.
        */}
        {waitingFor ? (
          <span className="tabular text-foreground"> · {waitingFor}</span>
        ) : null}
      </span>
    </div>
  );
}
