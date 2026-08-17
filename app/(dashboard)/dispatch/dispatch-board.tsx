'use client';

import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react';
import { AlertTriangle, MapPin, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  edgeScrollVelocity,
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
   * Jobs the server has accepted but this page has not been told about yet.
   *
   * `router.refresh()` re-renders the board from the server, and how long
   * that takes is not something a gesture can wait on — on a loaded board it
   * is comfortably long enough to look like nothing happened. The card sat
   * in the unassigned pile after a successful drop, so the operator dropped
   * it again.
   *
   * Hiding it the moment the server says yes makes the outcome part of the
   * gesture rather than a consequence of it. The refresh then arrives and
   * agrees, and the effect below drops the id once the server's own answer
   * no longer lists the job — so this can only ever run ahead of the truth,
   * never diverge from it.
   */
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  useEffect(() => {
    setAccepted((previous) => {
      if (previous.size === 0) return previous;
      const stillPending = new Set(
        [...previous].filter((id) => unassigned.some((block) => block.id === id)),
      );
      return stillPending.size === previous.size ? previous : stillPending;
    });
  }, [unassigned]);

  const waiting = unassigned.filter((block) => !accepted.has(block.id));

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

  /** Where every driver lane is, right now. */
  const measure = useCallback(() => {
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
  }, []);

  /**
   * A drag has passed the threshold: freeze the poll and take the layout.
   *
   * Note what this does *not* do any more: clear the message strip. It used
   * to, and that was a defect — the strip sits above the board and animates
   * its own height, so dismissing it slid every driver lane up the page by
   * about forty pixels while a card was in the air. The measurements taken a
   * frame earlier then pointed at the wrong rows, and a drop that landed
   * squarely on a driver resolved to nothing at all. The board would sit
   * there having silently ignored a completed gesture.
   *
   * The message is cleared when the drop resolves instead, which is when
   * there is a new answer to replace it with.
   */
  const handleDragStart = useCallback(
    (jobId: string) => {
      measure();
      setDragging(jobId);
    },
    [measure],
  );

  /**
   * The page scrolls itself while a card is held near the top or the bottom.
   *
   * Without it the board only accepts a drop on the part of itself that
   * happens to be on screen. That is not an edge case here: the first
   * customer runs 195 owner-drivers, `all=true` gives every one of them a
   * row, and a day's board is several screens tall. Reaching a driver who is
   * not currently visible was simply impossible — and a gesture that cannot
   * reach its target looks exactly like one that was refused, because in both
   * cases nothing happens and nothing is said.
   *
   * Runs on its own clock rather than off pointer moves, because the pointer
   * stops moving the moment it reaches the edge: the whole point is that
   * *holding* it there keeps the board coming.
   */
  const scroll = useRef<{ frame: number; last: number; velocity: number } | null>(
    null,
  );

  const stopScrolling = useCallback(() => {
    if (scroll.current) {
      cancelAnimationFrame(scroll.current.frame);
      scroll.current = null;
    }
  }, []);

  const pointer = useRef({ x: 0, y: 0 });

  const step = useCallback(
    (now: number) => {
      const state = scroll.current;
      if (!state) return;

      // Seconds since the last frame, so the speed is px per second however
      // fast the display refreshes — and clamped, because a tab that was
      // backgrounded returns with a gap of several seconds and would jump the
      // page to the bottom in one go.
      const elapsed = Math.min((now - state.last) / 1000, 1 / 30);
      state.last = now;

      window.scrollBy(0, state.velocity * elapsed);

      // The lanes have moved relative to the viewport, so the measurements
      // have to move with them or the highlight lags behind the page.
      measure();
      setOver(zoneAt(zones.current, pointer.current.x, pointer.current.y));

      state.frame = requestAnimationFrame(step);
    },
    [measure],
  );

  const setScrollVelocity = useCallback(
    (velocity: number) => {
      if (velocity === 0) {
        stopScrolling();
        return;
      }
      if (scroll.current) {
        scroll.current.velocity = velocity;
        return;
      }
      const state = { velocity, last: performance.now(), frame: 0 };
      scroll.current = state;
      state.frame = requestAnimationFrame(step);
    },
    [step, stopScrolling],
  );

  // Nothing keeps scrolling after the board has gone.
  useEffect(() => stopScrolling, [stopScrolling]);

  /**
   * Continuous feedback, every frame of the gesture.
   *
   * The old `dragover` handler could only say "the pointer is over me" from
   * the target's point of view, so the highlight flickered as the pointer
   * crossed gaps between rows. Resolved centrally from one set of
   * measurements, the answer is stable.
   */
  const handleDragMove = useCallback(
    (x: number, y: number) => {
      pointer.current = { x, y };
      setOver(zoneAt(zones.current, x, y));
      setScrollVelocity(edgeScrollVelocity(y, window.innerHeight));
    },
    [setScrollVelocity],
  );

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
      stopScrolling();

      // Measured again, not reused from the start of the drag. The highlight
      // can afford to be a frame stale; the decision cannot, and this is the
      // one moment where being wrong means silently discarding a gesture
      // somebody completed.
      measure();
      const driverId = zoneAt(zones.current, x, y);
      setOver(null);

      if (!driverId) {
        setDragging(null);
        return false;
      }

      setBusy(true);
      setMessage(null);
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
        setAccepted((previous) => new Set(previous).add(jobId));
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
    [measure, router, stopScrolling],
  );

  return (
    <div className="space-y-4">
      {/*
        A refusal arrives rather than appears. The gesture that caused it has
        just finished at the other end of the board, so the message has to
        announce itself or it is read as part of the furniture.
      */}
      <AnimatePresence initial={false}>
        {message ? (
          <motion.div
            key="dispatch-message"
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={SPRING.snappy}
            className="rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm"
            data-testid="dispatch-message"
            role="status"
          >
            {message}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex gap-4">
        {/* Unassigned first, on the left, because it is the pile of work
            somebody has to clear. */}
        <aside className="w-56 shrink-0" data-testid="unassigned-column">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Unassigned ({waiting.length})
          </h2>
          {waiting.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Everything has a driver.
            </p>
          ) : (
            <ul className="space-y-2">
              {waiting.map((block) => (
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
      // Page coordinates, not viewport ones.
      //
      // The card's translation is measured from where the gesture started,
      // and its own layout box lives in the document — so if the board
      // auto-scrolls, a translation computed from `clientX/Y` leaves the card
      // behind by exactly the distance scrolled. Held at the bottom edge of a
      // long board, it drifted several hundred pixels off the cursor and out
      // of the window while the drop still worked, which reads as the card
      // having been dropped somewhere by accident.
      originX: event.pageX,
      originY: event.pageY,
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

    /*
     * Two coordinate spaces, and they are not interchangeable.
     *
     * `page` is where the pointer is in the document, and it is what the
     * card's transform is measured against — so the card stays under the
     * cursor even as the board scrolls beneath both of them.
     *
     * `client` is where the pointer is on the screen, which is what the drop
     * zones are measured in (`getBoundingClientRect`) and what decides which
     * row is under the pointer.
     */
    const page = { x: event.pageX, y: event.pageY };
    const client = { x: event.clientX, y: event.clientY };

    if (!active.committed) {
      if (!hasCommitted({ x: active.originX, y: active.originY }, page)) return;
      active.committed = true;
      swallowClick.current = true;
      onDragStart(block.id);
    }

    // The offset from where it was grabbed, not from the card's centre. Grab
    // a card by its corner and it stays held by that corner.
    x.set(page.x - active.originX);
    y.set(page.y - active.originY);

    // Sampled in the same space the spring animates in, so the velocity
    // handed to it on release is the velocity it is about to undo.
    active.xs = pushSample(active.xs, { position: page.x, time: event.timeStamp });
    active.ys = pushSample(active.ys, { position: page.y, time: event.timeStamp });

    onDragMove(client.x, client.y);
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
