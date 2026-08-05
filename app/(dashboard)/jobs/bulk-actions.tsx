'use client';

import { AlertCircle } from 'lucide-react';
import { createContext, useContext, useMemo, useState } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { TableCell, TableHead } from '@/components/ui/table';
import { JOB_STATUSES } from '@/lib/enum-options';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

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

export function BulkActionBar({
  priceAction,
  transitionAction,
  mayPrice,
  mayTransition,
}: {
  priceAction: (state: FormState, formData: FormData) => Promise<FormState>;
  transitionAction: (state: FormState, formData: FormData) => Promise<FormState>;
  mayPrice: boolean;
  mayTransition: boolean;
}) {
  const { selected } = useSelection();
  const [mode, setMode] = useState<'price' | 'status'>(
    mayPrice ? 'price' : 'status',
  );

  if (!mayPrice && !mayTransition) return null;

  const ids = [...selected];
  // Nothing selected means nothing to offer; the bar would just be noise.
  if (ids.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border bg-muted/30 p-3" data-testid="bulk-bar">
      <div className="flex flex-wrap items-end gap-3">
        <span className="pb-2 text-sm font-medium" data-testid="bulk-count">
          {ids.length} selected
        </span>

        {mayPrice && mayTransition ? (
          <div>
            <label htmlFor="bulk-mode" className="mb-1.5 block text-sm font-medium">
              Action
            </label>
            <Select
              id="bulk-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as 'price' | 'status')}
              className="w-44"
            >
              <option value="price">Set prices</option>
              <option value="status">Change status</option>
            </Select>
          </div>
        ) : null}

        {mode === 'price' && mayPrice ? (
          <BulkPriceForm action={priceAction} ids={ids} />
        ) : null}
        {mode === 'status' && mayTransition ? (
          <BulkStatusForm action={transitionAction} ids={ids} />
        ) : null}
      </div>
    </div>
  );
}

function BulkPriceForm({
  action,
  ids,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  ids: string[];
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      {ids.map((id) => (
        <input key={id} type="hidden" name="jobIds" value={id} />
      ))}
      <div>
        <label htmlFor="bulk-client-price" className="mb-1.5 block text-sm font-medium">
          Client price
        </label>
        <Input
          id="bulk-client-price"
          name="clientPrice"
          inputMode="decimal"
          placeholder="125.50"
          className="w-32"
        />
      </div>
      <div>
        <label htmlFor="bulk-driver-price" className="mb-1.5 block text-sm font-medium">
          Driver price
        </label>
        <Input
          id="bulk-driver-price"
          name="driverPrice"
          inputMode="decimal"
          placeholder="80.00"
          className="w-32"
        />
      </div>
      <BulkSubmit label={`Price ${ids.length} job${ids.length === 1 ? '' : 's'}`} />
      <BulkResult state={state} />
    </form>
  );
}

function BulkStatusForm({
  action,
  ids,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  ids: string[];
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      {ids.map((id) => (
        <input key={id} type="hidden" name="jobIds" value={id} />
      ))}
      <div>
        <label htmlFor="bulk-status" className="mb-1.5 block text-sm font-medium">
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
      <BulkSubmit label={`Update ${ids.length} job${ids.length === 1 ? '' : 's'}`} />
      <BulkResult state={state} />
    </form>
  );
}

function BulkSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Working…' : label}
    </Button>
  );
}

/** Partial success is a normal outcome here, so it is reported in full. */
function BulkResult({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <Alert variant="warning" className="mt-2 basis-full" data-testid="bulk-result">
      <AlertCircle aria-hidden />
      <AlertDescription>{state.error}</AlertDescription>
    </Alert>
  );
}
