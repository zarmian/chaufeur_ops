import { AlertTriangle, ChevronDown, ChevronUp, Plane, Printer } from 'lucide-react';
import Link from 'next/link';
import { UnpricedBadge } from '@/components/unpriced-badge';
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
import type { DispatchDaySummary, DispatchRange } from '@/lib/dispatch';
import { cn } from '@/lib/utils';
import { AssignPicker } from './assign-picker';
import { ProgressPips } from './progress-pips';

/**
 * One day's work, as rows.
 *
 * A row rather than a block on an axis, and that is the change. A ninety
 * minute job on a nineteen-hour timeline is about eight percent of the width
 * — enough for a start time and a truncated pickup, with the client, the
 * passenger, the car and the price left to a tooltip nobody hovers. The same
 * job as a row carries all of it, and twelve of them fit on a screen.
 *
 * The timeline is still here, behind the disclosure, because "who is free at
 * two" is a question rows answer badly and an axis answers instantly. It is
 * one view of the day now rather than the whole page.
 */
export function DaySection({
  day,
  drivers,
  mayAssign,
  timelineHref,
  timelineOpen,
  children,
}: {
  day: DispatchDaySummary;
  drivers: DispatchRange['drivers'];
  mayAssign: boolean;
  timelineHref: string;
  timelineOpen: boolean;
  /** The timeline itself, rendered by the page when this day is open. */
  children?: React.ReactNode;
}) {
  return (
    <section
      id={`day-${day.date}`}
      className="mb-8 scroll-mt-20"
      aria-labelledby={`heading-${day.date}`}
      data-testid="day-section"
      data-date={day.date}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={`heading-${day.date}`} className="text-lg font-semibold">
            {day.label}
          </h2>
          <span className="text-sm text-muted-foreground tabular">
            {day.counts.jobs} {day.counts.jobs === 1 ? 'job' : 'jobs'}
          </span>
          {/* Only the counts that are non-zero. A row of zeroes is a row of
              nothing, and it teaches people to stop reading the strip. */}
          {day.counts.unassigned > 0 ? (
            <Badge variant="warning">{day.counts.unassigned} to fill</Badge>
          ) : null}
          {day.counts.conflicts > 0 ? (
            <Badge variant="destructive">{day.counts.conflicts} clashing</Badge>
          ) : null}
          {day.counts.unpriced > 0 ? (
            <Badge variant="warning">{day.counts.unpriced} with no price</Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            The morning print run. An office wants the day's boards as one
            stack in the order the cars go out — the top sheet is the next
            driver to leave — not eleven separate downloads.
          */}
          {day.counts.nameBoards > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={`/api/dispatch/name-boards?day=${day.date}`}
                target="_blank"
                rel="noreferrer"
                data-testid="print-name-boards"
              >
                <Printer aria-hidden />
                {day.counts.nameBoards} name{' '}
                {day.counts.nameBoards === 1 ? 'board' : 'boards'}
              </Link>
            </Button>
          ) : null}

          {day.counts.jobs > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={timelineHref} scroll={false} data-testid="timeline-toggle">
                {timelineOpen ? (
                  <ChevronUp aria-hidden />
                ) : (
                  <ChevronDown aria-hidden />
                )}
                {timelineOpen ? 'Hide the timeline' : 'By driver'}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {timelineOpen ? <div className="mb-4">{children}</div> : null}

      {day.counts.jobs === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing booked.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Time</TableHead>
              {/* Wide enough for the reference on one line. Broken across two
                  it stops being a token you can match against a phone call. */}
              <TableHead className="w-32">Reference</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead className="w-56">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {day.jobs.map((job) => (
              <TableRow
                key={job.id}
                data-testid="dispatch-job-row"
                data-job-id={job.id}
                className={cn(
                  job.conflictsWith.length > 0 && 'bg-destructive/5',
                  !job.driverId && 'bg-warning/5',
                )}
              >
                <TableCell className="tabular align-top font-medium">
                  {job.startLabel}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {job.endLabel}
                  </span>
                </TableCell>

                <TableCell className="align-top">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="whitespace-nowrap font-medium hover:underline"
                  >
                    {job.reference}
                  </Link>
                  {job.unpriced ? (
                    <UnpricedBadge className="mt-1 block w-fit" />
                  ) : null}
                </TableCell>

                <TableCell className="align-top">
                  <span className="block">
                    {job.pickupText} → {job.dropoffText}
                  </span>
                  {job.flightNumber ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Plane className="size-3" aria-hidden />
                      {job.flightNumber}
                    </span>
                  ) : null}
                  {job.conflictsWith.length > 0 ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="size-3" aria-hidden />
                      Clashes with {job.conflictsWith.length} other
                      {job.conflictsWith.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </TableCell>

                <TableCell className="align-top text-muted-foreground">
                  {job.clientName ?? '—'}
                  {job.passengerName ? (
                    <span className="block text-xs">{job.passengerName}</span>
                  ) : null}
                </TableCell>

                <TableCell className="align-top">
                  {job.driverName ? (
                    <>
                      <span>{job.driverName}</span>
                      {job.vehicleRegistration ? (
                        <span className="block font-mono text-xs text-muted-foreground">
                          {job.vehicleRegistration}
                        </span>
                      ) : null}
                    </>
                  ) : mayAssign ? (
                    <AssignPicker jobId={job.id} drivers={drivers} />
                  ) : (
                    <span className="italic text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>

                <TableCell className="align-top">
                  <ProgressPips
                    progress={job.progress}
                    label={job.progressLabel}
                    waitingFor={job.waitingFor}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
