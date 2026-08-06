'use client';

import { AlertTriangle, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
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

  async function assign(jobId: string, driverId: string) {
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
      } else if (json.warning) {
        // Spec 6.2.3 — a conflict warns and lets the assignment stand. The
        // operator knows the traffic and the driver; the system does not.
        setMessage(json.warning);
      }
      router.refresh();
    } catch {
      setMessage('That could not be assigned.');
    } finally {
      setBusy(false);
      setDragging(null);
      setOver(null);
    }
  }

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
                  <div
                    draggable={canAssign}
                    onDragStart={() => setDragging(block.id)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    className={cn(
                      'rounded-md border bg-card p-2 text-xs',
                      canAssign && 'cursor-grab active:cursor-grabbing',
                      dragging === block.id && 'opacity-50',
                    )}
                    data-testid="unassigned-job"
                    data-job-id={block.id}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <Link
                        href={`/jobs/${block.id}`}
                        className="font-medium hover:underline"
                      >
                        {block.reference}
                      </Link>
                      <span className="tabular text-muted-foreground">
                        {block.startLabel}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-muted-foreground">
                      {block.pickupText} → {block.dropoffText}
                    </p>
                    {block.unpriced ? (
                      <Badge variant="warning" className="mt-1">
                        No price
                      </Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="min-w-0 flex-1 overflow-x-auto">
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
                  </div>

                  <div
                    className={cn(
                      'relative min-h-[3.25rem] flex-1 border-l',
                      over === row.driverId && 'bg-accent',
                    )}
                    onDragOver={(event) => {
                      if (!canAssign || !dragging) return;
                      event.preventDefault();
                      setOver(row.driverId);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragging) void assign(dragging, row.driverId);
                    }}
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
