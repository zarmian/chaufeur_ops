import { X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatGBP } from '@/lib/money';

/**
 * Itemised expenses on a job.
 *
 * A Server Component with plain form posts — no client state is needed, and
 * it keeps working without JavaScript.
 *
 * The bearer is the field that matters. The default offered follows the
 * driver's engagement (the company buys the fuel for a hired driver, the
 * driver buys their own), but it is always a choice, because the person
 * entering it knows what actually happened.
 */

const EXPENSE_KINDS = [
  { value: 'PARKING', label: 'Parking' },
  { value: 'CONGESTION_CHARGE', label: 'Congestion charge' },
  { value: 'ULEZ', label: 'ULEZ' },
  { value: 'TOLL', label: 'Toll' },
  { value: 'FUEL', label: 'Fuel' },
  { value: 'WAITING', label: 'Waiting' },
  { value: 'OTHER', label: 'Other' },
] as const;

const BEARERS = [
  { value: 'CLIENT', label: 'Recharge to the client' },
  { value: 'COMPANY', label: 'We absorb it' },
  { value: 'DRIVER', label: 'The driver absorbs it' },
] as const;

const BEARER_BADGE: Record<string, { label: string; variant: 'success' | 'warning' | 'secondary' }> = {
  CLIENT: { label: 'Recharged', variant: 'success' },
  COMPANY: { label: 'Our cost', variant: 'warning' },
  DRIVER: { label: "Driver's cost", variant: 'secondary' },
};

export interface ExpenseRow {
  id: string;
  kind: string;
  amountPence: number;
  note: string | null;
  borneBy: string;
}

export function ExpensesPanel({
  jobId,
  expenses,
  defaultBearer,
  mayEdit,
  error,
}: {
  jobId: string;
  expenses: ExpenseRow[];
  defaultBearer: string;
  mayEdit: boolean;
  error?: string | null;
}) {
  const action = `/api/jobs/${jobId}/expenses`;

  return (
    <div className="space-y-4" data-testid="expenses-panel">
      {error ? (
        <Alert variant="destructive" data-testid="expense-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {expenses.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing recorded. Parking, congestion charges and tolls belong here —
          recharged ones become revenue.
        </p>
      ) : (
        <ul className="divide-y">
          {expenses.map((expense) => {
            const badge = BEARER_BADGE[expense.borneBy] ?? BEARER_BADGE.COMPANY!;
            return (
              <li key={expense.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {EXPENSE_KINDS.find((k) => k.value === expense.kind)?.label ??
                      expense.kind}
                    {expense.note ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {expense.note}
                      </span>
                    ) : null}
                  </p>
                </div>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                <span className="tabular whitespace-nowrap text-sm">
                  {formatGBP(expense.amountPence)}
                </span>
                {mayEdit ? (
                  <form method="post" action={action}>
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="expenseId" value={expense.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove this expense"
                    >
                      <X aria-hidden />
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {mayEdit ? (
        <form
          method="post"
          action={action}
          className="grid gap-2 border-t pt-4 sm:grid-cols-[9rem_7rem_1fr_auto]"
        >
          <div>
            <label htmlFor="kind" className="mb-1 block text-xs text-muted-foreground">
              Kind
            </label>
            <Select id="kind" name="kind" defaultValue="PARKING">
              {EXPENSE_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="amount" className="mb-1 block text-xs text-muted-foreground">
              Amount
            </label>
            <Input id="amount" name="amount" inputMode="decimal" placeholder="15.00" />
          </div>
          <div>
            <label htmlFor="borneBy" className="mb-1 block text-xs text-muted-foreground">
              Who pays
            </label>
            <Select id="borneBy" name="borneBy" defaultValue={defaultBearer}>
              {BEARERS.map((bearer) => (
                <option key={bearer.value} value={bearer.value}>
                  {bearer.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit">Add</Button>
          </div>
          <input type="hidden" name="note" value="" />
        </form>
      ) : null}
    </div>
  );
}
