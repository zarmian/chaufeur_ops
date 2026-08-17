'use client';

import { AnimatePresence, motion } from 'motion/react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { TableCell, TableHead } from '@/components/ui/table';
import { JOB_STATUSES } from '@/lib/enum-options';
import { SPRING } from '@/lib/motion';

/**
 * Row selection, and the two things you can do with a selection.
 *
 * Bulk pricing exists for backfilling imported data: a CSV import can land
 * hundreds of jobs with no price, and fixing them one at a time is not
 * something anyone will actually do.
 *
 * Bulk status change validates each job on its own — one job missing a price
 * must not stop the other nine completing — and reports per job, so a partial
 * success names exactly which were refused and why.
 *
 * Every action is a plain form post to `/api/jobs/bulk`, never a Server
 * Action. As Server Actions these hung: the action applied its changes,
 * called `revalidatePath` on the list it was posted from, and the router
 * aborted the in-flight response to refetch — so the result never arrived and
 * the button stayed on "Working…" for ever, over jobs that had in fact been
 * updated. The outcome now comes back on the query string instead.
 *
 * Only the checkbox cells and the toolbar are Client Components. The table
 * itself stays server-rendered, which matters: at 10,000 jobs the row markup
 * is the thing that must not turn into client JavaScript.
 */

interface SelectionContext {
  selected: Set<string>;
  toggle: (id: string, checked: boolean) => void;
  setAll: (ids: string[], checked: boolean) => void;
}

const Selection = createContext<SelectionContext | null>(null);

export function BulkSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const value = useMemo<SelectionContext>(
    () => ({
      selected,
      toggle: (id, checked) =>
        setSelected((current) => {
          const next = new Set(current);
          if (checked) next.add(id);
          else next.delete(id);
          return next;
        }),
      setAll: (ids, checked) => setSelected(checked ? new Set(ids) : new Set()),
    }),
    [selected],
  );

  return <Selection.Provider value={value}>{children}</Selection.Provider>;
}

function useSelection(): SelectionContext {
  const context = useContext(Selection);
  if (!context) {
    throw new Error('Job selection used outside BulkSelectionProvider');
  }
  return context;
}

/** The checkbox in a job row. Rendered by the server component's map. */
export function JobRowCheckbox({
  jobId,
  label,
}: {
  jobId: string;
  label: string;
}) {
  const { selected, toggle } = useSelection();
  return (
    <TableCell className="w-8">
      <input
        type="checkbox"
        className="size-4 rounded border-input"
        checked={selected.has(jobId)}
        onChange={(event) => toggle(jobId, event.target.checked)}
        aria-label={`Select ${label}`}
      />
    </TableCell>
  );
}

/** The select-all checkbox in the header row. */
export function JobSelectAllHeader({ jobIds }: { jobIds: string[] }) {
  const { selected, setAll } = useSelection();
  const all = jobIds.length > 0 && jobIds.every((id) => selected.has(id));

  return (
    <TableHead className="w-8">
      <input
        type="checkbox"
        className="size-4 rounded border-input"
        checked={all}
        onChange={(event) => setAll(jobIds, event.target.checked)}
        aria-label="Select every job on this page"
      />
    </TableHead>
  );
}

type BulkMode = 'price' | 'status' | 'assign' | 'invoice';

export interface BulkOption {
  id: string;
  label: string;
}

export function BulkActionBar({
  mayPrice,
  mayTransition,
  mayAssign = false,
  mayInvoice = false,
  drivers = [],
  draftInvoices = [],
  backgroundThreshold,
  returnTo,
}: {
  mayPrice: boolean;
  mayTransition: boolean;
  mayAssign?: boolean;
  mayInvoice?: boolean;
  /** Spec 6.5.2. Empty hides the option rather than offering an empty list. */
  drivers?: BulkOption[];
  /** Only drafts: an invoice that has been sent is immutable (spec 4.3). */
  draftInvoices?: BulkOption[];
  /** Above this the work runs in the background — spec 6.5.4. */
  backgroundThreshold: number;
  /** The list to come back to, filters and page intact. */
  returnTo: string;
}) {
  const { selected } = useSelection();

  const canAssign = mayAssign && drivers.length > 0;
  const canInvoice = mayInvoice && draftInvoices.length > 0;

  const modes: Array<{ value: BulkMode; label: string }> = [
    ...(mayPrice ? [{ value: 'price' as const, label: 'Set prices' }] : []),
    ...(mayTransition
      ? [{ value: 'status' as const, label: 'Change status' }]
      : []),
    ...(canAssign
      ? [{ value: 'assign' as const, label: 'Assign driver' }]
      : []),
    ...(canInvoice
      ? [{ value: 'invoice' as const, label: 'Add to invoice' }]
      : []),
  ];

  const [mode, setMode] = useState<BulkMode>(modes[0]?.value ?? 'price');

  if (modes.length === 0) return null;

  const ids = [...selected];

  return (
    /*
     * The bar arrives instead of appearing.
     *
     * It used to be `if (ids.length === 0) return null`, so ticking the first
     * checkbox inserted a block of controls in one frame and everything below
     * it jumped down the page — on a list somebody is working through, that
     * moves the row they were about to tick out from under the pointer.
     *
     * Animating the height means the list is pushed rather than displaced,
     * and unticking the last box reverses the same movement. Nothing is
     * rendered at all when the selection is empty, so `AnimatePresence` has
     * something to remove rather than something to hide.
     */
    <AnimatePresence initial={false}>
      {ids.length > 0 ? (
        <motion.div
          key="bulk-bar"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={SPRING.snappy}
          className="overflow-hidden"
        >
          <div
            className="mb-4 rounded-lg border bg-muted/30 p-3"
            data-testid="bulk-bar"
          >
            <div className="flex flex-wrap items-end gap-3">
              <span
                className="pb-2 text-sm font-medium"
                data-testid="bulk-count"
              >
                {ids.length} selected
              </span>

              {modes.length > 1 ? (
                <div>
                  <label
                    htmlFor="bulk-mode"
                    className="mb-1.5 block text-sm font-medium"
                  >
                    Action
                  </label>
                  <Select
                    id="bulk-mode"
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as BulkMode)
                    }
                    className="w-44"
                  >
                    {modes.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}

              <BulkForm intent={mode} ids={ids} returnTo={returnTo}>
                {mode === 'price' ? (
                  <>
                    <div>
                      <label
                        htmlFor="bulk-client-price"
                        className="mb-1.5 block text-sm font-medium"
                      >
                        Client price
                      </label>
                      <Input
                        id="bulk-client-price"
                        name="clientPrice"
                        inputMode="decimal"
                        placeholder="Leave blank to keep"
                        className="w-44"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="bulk-driver-price"
                        className="mb-1.5 block text-sm font-medium"
                      >
                        Driver price
                      </label>
                      <Input
                        id="bulk-driver-price"
                        name="driverPrice"
                        inputMode="decimal"
                        placeholder="Leave blank to keep"
                        className="w-44"
                      />
                    </div>
                    <BulkSubmit verb="Price" count={ids.length} />
                  </>
                ) : null}

                {mode === 'status' ? (
                  <>
                    <div>
                      <label
                        htmlFor="bulk-status"
                        className="mb-1.5 block text-sm font-medium"
                      >
                        Move to
                      </label>
                      <Select id="bulk-status" name="status" className="w-44">
                        {JOB_STATUSES.map((status) => (
                          <option key={status.value} value={status.value}>
                            {status.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <BulkSubmit verb="Update" count={ids.length} />
                  </>
                ) : null}

                {mode === 'assign' ? (
                  <>
                    <Chooser
                      id="bulk-driver"
                      name="driverId"
                      label="Driver"
                      placeholder="Choose a driver"
                      options={drivers}
                    />
                    <BulkSubmit verb="Assign" count={ids.length} />
                  </>
                ) : null}

                {mode === 'invoice' ? (
                  <>
                    <Chooser
                      id="bulk-invoice"
                      name="invoiceId"
                      label="Draft invoice"
                      placeholder="Choose a draft"
                      options={draftInvoices}
                    />
                    <BulkSubmit verb="Add" count={ids.length} />
                  </>
                ) : null}
              </BulkForm>

              {/* Spec 6.5.4. Said before the click, not after — somebody selecting
            four hundred jobs should know the answer will not be immediate. */}
              {ids.length > backgroundThreshold ? (
                <p className="basis-full text-xs text-muted-foreground">
                  More than {backgroundThreshold} jobs, so this runs in the
                  background. The result appears here when it finishes.
                </p>
              ) : null}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function BulkForm({
  intent,
  ids,
  returnTo,
  children,
}: {
  intent: BulkMode;
  ids: string[];
  returnTo: string;
  children: React.ReactNode;
}) {
  return (
    <form
      method="post"
      action="/api/jobs/bulk"
      className="flex flex-wrap items-end gap-3"
      data-testid={`bulk-form-${intent}`}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {ids.map((id) => (
        <input key={id} type="hidden" name="jobIds" value={id} />
      ))}
      {children}
    </form>
  );
}

/**
 * The empty first option is deliberate.
 *
 * A select that defaults to the first driver in the list is one somebody
 * submits without reading, and the action being defaulted into here puts a
 * named person on forty jobs.
 */
function Chooser({
  id,
  name,
  label,
  placeholder,
  options,
}: {
  id: string;
  name: string;
  label: string;
  placeholder: string;
  options: BulkOption[];
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <Select id={id} name={name} className="w-56" defaultValue="">
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function BulkSubmit({ verb, count }: { verb: string; count: number }) {
  return (
    <Button type="submit">
      {verb} {count} job{count === 1 ? '' : 's'}
    </Button>
  );
}

interface BulkProgressState {
  status: 'RUNNING' | 'DONE' | 'FAILED';
  total: number;
  succeeded: number;
  failed: number;
  failures: string[];
}

/**
 * Progress for a batch running behind the response — spec 6.5.4.
 *
 * A batch that vanishes the moment it is submitted is one the operator has to
 * guess about, and guessing usually means submitting it again — which for
 * "assign this driver to four hundred jobs" is not a harmless second click.
 *
 * Polling rather than a stream: the work writes progress every tenth job, so
 * there is nothing to push between those points, and a two-second poll on a
 * page somebody is already watching costs less than a held-open connection
 * per operator.
 */
export function BulkProgress({ operationId }: { operationId: string }) {
  const [progress, setProgress] = useState<BulkProgressState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs/bulk/${operationId}`, {
          cache: 'no-store',
        });
        if (cancelled || !response.ok) return;

        const json = (await response.json()) as BulkProgressState;
        if (cancelled) return;

        setProgress(json);
        if (json.status === 'RUNNING') timer = setTimeout(tick, 2000);
      } catch {
        // A dropped poll is not worth reporting — the next one recovers, and
        // the work is happening on the server either way.
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    };

    timer = setTimeout(tick, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [operationId]);

  if (!progress) return null;

  const done = progress.succeeded + progress.failed;

  return (
    <div
      className="mb-4 rounded-lg border p-3 text-sm"
      data-testid="bulk-progress"
    >
      {progress.status === 'RUNNING' ? (
        <p>
          {done} of {progress.total} done…
        </p>
      ) : (
        <p data-testid="bulk-progress-done">
          Finished: {progress.succeeded} updated
          {progress.failed > 0 ? `, ${progress.failed} refused` : ''}.
        </p>
      )}

      {/* Named, not counted — the whole reason the batch is worth watching. */}
      {progress.failures.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {progress.failures.slice(0, 20).map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
