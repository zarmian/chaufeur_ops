'use client';

import { animate, motion, useMotionValue } from 'motion/react';
import { AlertTriangle, MapPin, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  hasCommitted,
  pushSample,
  SPRING,
  velocityFrom,
  zoneAt,
  type Sample,
  type Zone,
} from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * The day, as a timeline — spec 6.1.
 *
 * A Client Component for one reason: drag and drop. Everything else here
 * could render on the server, and the data does — the arithmetic that
 * positions a block is done in `lib/dispatch.ts` and arrives as percentages,
 * so this file only draws.
 *
 * The types are declared here rather than imported from `lib/dispatch.ts`,
 * which imports Prisma. Importing the type alone would be safe at runtime but
 * the guard in `lib/client-bundle.test.ts` walks imports rather than types,
 * and a rule that has to be reasoned about is a rule that eventually breaks.
 *
 * ## The drag
 *
 * This used to be the HTML5 drag-and-drop API — `draggable`, `dragstart`,
 * `dragover`, `drop`. Four things were wrong with it, and all four are the
 * same thing: that API reports a *result*, not a gesture.
 *
 * - The card did not move. The browser took a translucent screenshot of it
 *   and dragged that instead, at whatever offset the browser felt like, while
 *   the real card sat where it was at 50% opacity.
 * - It could not be interrupted or reversed. Nothing followed the pointer, so
 *   there was nothing to catch and put back.
 * - A refused drop — a lapsed PHV badge, say — ended with the card simply
 *   still being there. Nothing connected the refusal to the gesture that
 *   caused it.
 * - `dragover` fires on a target, so the only feedback available was a
 *   highlight that flickered on and off between rows.
 *
 * It is Pointer Events now: capture on the way down, 1:1 tracking from the
 * point that was actually grabbed, a ten-pixel threshold before a click
 * becomes a drag, and a spring home carrying the release velocity when the
 * drop is refused. The physics lives in `lib/motion.ts` and is tested there.
 */

export interface Block {
  id: string;
  reference: string;
  startLabel: string;
  endLabel: string;
  minutes: number;
  status: string;
  pickupText: string;
  dropoffText: string;
  clientName: string | null;
  passengerName: string | null;
  vehicleRegistration: string | null;
  flightNumber: string | null;
  unpriced: boolean;
  conflictsWith: string[];
  leftPct: number;
  widthPct: number;
}

export interface Row {
  driverId: string;
  driverName: string;
  vehicleRegistration: string | null;
  telegramLinked: boolean;
  /** Serialised over the RSC boundary, so a string rather than a Date. */
  lastSeenAt: string | null;
  etaPhrase: string | null;
  blocks: Block[];
}

const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground border-border',
  PENDING: 'bg-muted text-muted-foreground border-border',
  ASSIGNED: 'bg-primary/70 text-primary-foreground border-primary',
  ACCEPTED: 'bg-warning/80 text-warning-foreground border-warning',
  IN_PROGRESS: 'bg-success/80 text-success-foreground border-success',
  COMPLETED: 'bg-success text-success-foreground border-success',
  NO_SHOW: 'bg-destructive text-destructive-foreground border-destructive',
};

export function DispatchBoard({
  rows,
  unassigned,
  hours,
  nowPct,
  canAssign,
  refreshSeconds,
}: {
  rows: Row[];
  unassigned: Block[];
  hours: number[];
  nowPct: number | null;
  canAssign: boolean;
  refreshSeconds: number;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Where the driver rows are, measured once when a drag commits.
   *
   * Measuring on every pointer move would mean a layout read per frame — and
   * they cannot move during a drag anyway, because the poll is paused. See
   * `zoneAt` for why this is geometry rather than `elementFromPoint`.
   */
  const board = useRef<HTMLDivElement>(null);
  const zones = useRef<Zone[]>([]);

  /**
   * Live refresh — spec 6.1.9.
   *
   * A poll rather than SSE. Thirty seconds is well inside what a dispatcher
   * notices, and a long-lived connection per open board is a cost that has to
   * earn itself; on a serverless host it earns itself slowly.
   *
   * Paused while a drag is in flight: refreshing the board out from under
   * somebody's hand loses the drag and looks like a bug.
   */
  const draggingRef = useRef(false);
  draggingRef.current = dragging !== null || busy;

  useEffect(() => {
    if (refreshSeconds <= 0) return;
    const timer = setInterval(() => {
      if (!draggingRef.current) router.refresh();
    }, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds, router]);

  /** A drag has passed the threshold: freeze the poll and take the layout. */
  const handleDragStart = useCallback((jobId: string) => {
    const lanes =
      board.current?.querySelectorAll<HTMLElement>('[data-driver-id]') ?? [];
    zones.current = Array.from(lanes).map((lane) => {
      const rect = lane.getBoundingClientRect();
      return {
        id: lane.dataset.driverId ?? '',
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
    });
    setDragging(jobId);
    setMessage(null);
  }, []);

  /**
   * Continuous feedback, every frame of the gesture.
   *
   * The old `dragover` handler could only say "the pointer is over me" from
   * the target's point of view, so the highlight flickered as the pointer
   * crossed gaps between rows. Resolved centrally from one set of
   * measurements, the answer is stable.
   */
  const handleDragMove = useCallback((x: number, y: number) => {
    setOver(zoneAt(zones.current, x, y));
  }, []);

  /**
   * Where the drag ended, and whether the board took it.
   *
   * Returns false when the card should come home — dropped on nothing, or
   * refused. The card springs back from wherever it was let go, carrying the
   * velocity it had, so a refusal is visibly the *undoing of the gesture*
   * rather than an unrelated message appearing at the top of the page.
   */
  const handleDrop = useCallback(
    async (jobId: string, x: number, y: number): Promise<boolean> => {
      const driverId = zoneAt(zones.current, x, y);
      setOver(null);

      if (!driverId) {
        setDragging(null);
        return false;
      }

      setBusy(true);
      try {
        const response = await fetch('/api/dispatch/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, driverId }),
        });
        const json = (await response.json()) as {
          ok?: boolean;
          message?: string;
          warning?: string;
        };

        if (!response.ok || !json.ok) {
          setMessage(json.message ?? 'That could not be assigned.');
          return false;
        }

        if (json.warning) {
          // Spec 6.2.3 — a conflict warns and lets the assignment stand. The
          // operator knows the traffic and the driver; the system does not.
          setMessage(json.warning);
        }
        router.refresh();
        return true;
      } catch {
        setMessage('That could not be assigned.');
        return false;
      } finally {
        setBusy(false);
        setDragging(null);
      }
    },
    [router],
  );

  return (
    <div className="space-y-4">
      {message ? (
        <div
          className="rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm"
          data-testid="dispatch-message"
          role="status"
        >
          {message}
        </div>
      ) : null}

      <div className="flex gap-4">
        {/* Unassigned first, on the left, because it is the pile of work
            somebody has to clear. */}
        <aside className="w-56 shrink-0" data-testid="unassigned-column">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Unassigned ({unassigned.length})
          </h2>
          {unassigned.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Everything has a driver.
            </p>
          ) : (
            <ul className="space-y-2">
              {unassigned.map((block) => (
                <li key={block.id}>
                  <UnassignedCard
                    block={block}
                    canAssign={canAssign}
                    isDragging={dragging === block.id}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDrop={handleDrop}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="min-w-0 flex-1 overflow-x-auto" ref={board}>
          <div className="min-w-[52rem]">
            {/* Hours across the top. */}
            <div className="sticky top-0 z-10 flex border-b bg-background">
              <div className="w-40 shrink-0 py-1 text-xs font-medium text-muted-foreground">
                Driver
              </div>
              <div className="relative flex-1">
                <div className="flex">
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className="flex-1 border-l py-1 pl-1 text-xs tabular text-muted-foreground"
                    >
                      {String(hour % 24).padStart(2, '0')}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing booked, and no driver has anything on.
              </p>
            ) : (
              rows.map((row) => (
                <div key={row.driverId} className="flex border-b last:border-b-0">
                  <div className="w-40 shrink-0 py-2 pr-2 text-sm">
                    <Link
                      href={`/drivers/${row.driverId}`}
                      className="font-medium hover:underline"
                    >
                      {row.driverName}
                    </Link>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      {row.vehicleRegistration ?? 'no car'}
                      {row.telegramLinked ? (
                        <Send className="size-3" aria-label="Linked to Telegram" />
                      ) : null}
                    </p>
                    {/* Only while a driver is actually sharing position and
                        mid-job. The rest of the time the row says nothing
                        rather than something reassuring and untrue. */}
                    {row.etaPhrase ? (
                      <p
                        className="flex items-center gap-1 text-xs text-muted-foreground"
                        title={
                          row.lastSeenAt
                            ? `Last position ${new Date(row.lastSeenAt).toLocaleTimeString()}`
                            : undefined
                        }
                      >
                        <MapPin className="size-3" aria-hidden="true" />
                        <span>{row.etaPhrase}</span>
                      </p>
                    ) : null}
                  </div>

                  <div
                    className={cn(
                      'relative min-h-[3.25rem] flex-1 border-l transition-colors duration-fast ease-out',
                      // Only ever the one row, and only while something is
                      // actually in the air.
                      dragging && over === row.driverId
                        ? 'bg-accent ring-2 ring-inset ring-ring'
                        : null,
                    )}
                    data-testid="driver-row"
                    data-driver-id={row.driverId}
                  >
                    {/* Hour gridlines, behind the blocks. */}
                    <div className="pointer-events-none absolute inset-0 flex">
                      {hours.map((hour) => (
                        <div key={hour} className="flex-1 border-l border-border/40" />
                      ))}
                    </div>

                    {row.blocks.map((block) => (
                      <Link
                        key={block.id}
                        href={`/jobs/${block.id}`}
                        title={brief(block)}
                        style={{
                          left: `${block.leftPct}%`,
                          width: `${block.widthPct}%`,
                        }}
                        className={cn(
                          'absolute top-1.5 h-10 overflow-hidden rounded border px-1.5 py-0.5 text-[11px] leading-tight',
                          STATUS_CLASS[block.status] ?? 'bg-muted',
                          // Spec 6.2.6. Only genuine overlaps, so the outline
                          // still means something.
                          block.conflictsWith.length > 0 &&
                            'ring-2 ring-destructive ring-offset-1 ring-offset-background',
                        )}
                        data-testid="dispatch-block"
                        data-job-id={block.id}
                      >
                        <span className="flex items-center gap-1 font-medium">
                          {block.conflictsWith.length > 0 ? (
                            <AlertTriangle className="size-3 shrink-0" aria-hidden />
                          ) : null}
                          {block.startLabel}
                        </span>
                        <span className="block truncate opacity-90">
                          {block.pickupText}
                        </span>
                      </Link>
                    ))}

                    {nowPct !== null ? (
                      <div
                        className="pointer-events-none absolute inset-y-0 w-px bg-destructive"
                        style={{ left: `${nowPct}%` }}
                        aria-hidden
                      />
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A job waiting for a driver, and the gesture that gives it one.
 *
 * Everything about the drag lives here rather than in the board, so the board
 * deals in "a job was dropped on a driver" and not in pointer ids.
 *
 * The card also contains a link to the job, which is the constraint that
 * shapes the rest: a drag has to be distinguishable from a click, or opening
 * a job by clicking its reference stops working. Hence the ten-pixel
 * threshold before anything moves, and the click suppression afterwards.
 */
function UnassignedCard({
  block,
  canAssign,
  isDragging,
  onDragStart,
  onDragMove,
  onDrop,
}: {
  block: Block;
  canAssign: boolean;
  isDragging: boolean;
  onDragStart: (jobId: string) => void;
  onDragMove: (x: number, y: number) => void;
  onDrop: (jobId: string, x: number, y: number) => Promise<boolean>;
}) {
  // Motion values, not state: a drag writes to these on every pointer move,
  // and re-rendering the board sixty times a second to move one card would
  // make the drag stutter on exactly the days it matters.
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  /** Live gesture, or null. A ref because none of it belongs in a render. */
  const gesture = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    committed: boolean;
    xs: Sample[];
    ys: Sample[];
  } | null>(null);

  /**
   * Set when a drag committed, cleared by the click it swallows.
   *
   * A pointer sequence that moved is still followed by a `click`, and without
   * this, dragging a card would also navigate to the job the moment it was
   * dropped.
   */
  const swallowClick = useRef(false);

  function goHome(velocityX: number, velocityY: number) {
    // Two springs, one per axis. A single spring on the 2D distance
    // desynchronises the moment the two axes have different speeds — which,
    // for a card thrown up and to the right, is always.
    animate(x, 0, { ...SPRING.momentum, velocity: velocityX });
    animate(y, 0, { ...SPRING.momentum, velocity: velocityY });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Primary button only: a right-click is a context menu, and a middle
    // click on a link is "open in a new tab".
    if (!canAssign || event.button !== 0) return;

    gesture.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      committed: false,
      xs: [],
      ys: [],
    };
    // Capture, so the card keeps receiving moves once the pointer has left
    // it — which it does immediately, since the whole point is to drag the
    // card somewhere else.
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;

    const point = { x: event.clientX, y: event.clientY };

    if (!active.committed) {
      if (!hasCommitted({ x: active.originX, y: active.originY }, point)) return;
      active.committed = true;
      swallowClick.current = true;
      onDragStart(block.id);
    }

    // The offset from where it was grabbed, not from the card's centre. Grab
    // a card by its corner and it stays held by that corner.
    x.set(point.x - active.originX);
    y.set(point.y - active.originY);

    active.xs = pushSample(active.xs, { position: point.x, time: event.timeStamp });
    active.ys = pushSample(active.ys, { position: point.y, time: event.timeStamp });

    onDragMove(point.x, point.y);
  }

  async function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;

    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }

    // Never moved: this was a click, and the link underneath should have it.
    if (!active.committed) return;

    // Read before awaiting — the event's fields are only valid during
    // dispatch, and `onDrop` is a round trip to the server.
    const dropX = event.clientX;
    const dropY = event.clientY;
    const velocityX = velocityFrom(active.xs);
    const velocityY = velocityFrom(active.ys);

    const accepted = await onDrop(block.id, dropX, dropY);
    // Refused, or dropped on nothing. Back where it came from, at the speed
    // it was travelling — no seam between the hand letting go and the card
    // returning. On acceptance it stays put and the board's refresh takes it.
    if (!accepted) goHome(velocityX, velocityY);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (active.committed) goHome(velocityFrom(active.xs), velocityFrom(active.ys));
  }

  return (
    <motion.div
      style={{
        x,
        y,
        // Ours, not the scroller's: without this a touch drag pans the page
        // instead of moving the card.
        touchAction: canAssign ? 'none' : undefined,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        swallowClick.current = false;
      }}
      animate={{
        // Lifted while it is in the air, so it reads as being carried over
        // the board rather than sliding along it.
        scale: isDragging ? 1.03 : 1,
      }}
      transition={SPRING.snappy}
      className={cn(
        'rounded-md border bg-card p-2 text-xs',
        canAssign && 'cursor-grab active:cursor-grabbing',
        isDragging
          ? 'relative z-30 cursor-grabbing shadow-sheet'
          : 'shadow-chip',
      )}
      data-testid="unassigned-job"
      data-job-id={block.id}
    >
      <div className="flex items-center justify-between gap-1">
        <Link href={`/jobs/${block.id}`} className="font-medium hover:underline">
          {block.reference}
        </Link>
        <span className="tabular text-muted-foreground">{block.startLabel}</span>
      </div>
      <p className="mt-1 truncate text-muted-foreground">
        {block.pickupText} → {block.dropoffText}
      </p>
      {block.unpriced ? (
        <Badge variant="warning" className="mt-1">
          No price
        </Badge>
      ) : null}
    </motion.div>
  );
}

function brief(block: Block): string {
  return [
    block.reference,
    `${block.startLabel}–${block.endLabel}`,
    `${block.pickupText} → ${block.dropoffText}`,
    block.passengerName ?? block.clientName,
    block.flightNumber,
    block.vehicleRegistration,
    block.unpriced ? 'NO PRICE' : null,
  ]
    .filter(Boolean)
    .join('\n');
}
