'use client';

import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PAY_METHODS, PAY_STATUSES } from '@/lib/enum-options';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import { calculateFinance } from '@/lib/job-finance';

/**
 * The finance panel.
 *
 * Every total on screen is recalculated as you type, so the operator sees the
 * gross profit before committing — but those numbers are never submitted. The
 * form posts only the inputs, and the server runs `calculateFinance` again on
 * what it received. The legacy system stored whatever the browser sent, which
 * is how a job could end up with a gross profit that did not follow from its
 * own figures.
 *
 * Amounts are held in pence here, matching the column, because a panel that
 * silently converts pounds is where rounding errors get introduced.
 */

export interface FinanceFormValues {
  baseFarePence: number;
  waitTimePence: number;
  waitMinutesBilled: number;
  extraChargesPence: number;
  extraChargesNotes: string;
  customerHours: string;
  customerRatePence: number;
  driverPaymentPence: number;
  fuelCostPence: number;
  otherExpensesPence: number;
  expenseNotes: string;
  driverHours: string;
  driverRatePence: number;
  driverPayStatus: string;
  driverPayMethod: string;
  driverPaidAt: string;
  paymentNotes: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save finances'}
    </Button>
  );
}

/** Pence as a display string. Kept local — this panel edits pence directly. */
function pounds(pence: number): string {
  return (pence / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function FinanceForm({
  action,
  values,
  cancelHref,
  readOnly = false,
  waitMinutesFromEvents,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values: FinanceFormValues;
  cancelHref: string;
  readOnly?: boolean;
  /**
   * Derived from the driver's ARRIVED and POB events once Phase 5 supplies
   * them. Null means nobody has recorded them, so the field stays editable
   * rather than silently reading as zero.
   */
  waitMinutesFromEvents: number | null;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};
  const [live, setLive] = useState(values);

  const totals = calculateFinance({
    baseFarePence: live.baseFarePence,
    waitTimePence: live.waitTimePence,
    extraChargesPence: live.extraChargesPence,
    customerHours: live.customerHours === '' ? null : Number(live.customerHours),
    customerRatePence: live.customerRatePence,
    driverPaymentPence: live.driverPaymentPence,
    fuelCostPence: live.fuelCostPence,
    otherExpensesPence: live.otherExpensesPence,
    driverHours: live.driverHours === '' ? null : Number(live.driverHours),
    driverRatePence: live.driverRatePence,
  });

  const set = (key: keyof FinanceFormValues) => (value: string) =>
    setLive((current) => ({
      ...current,
      [key]:
        key === 'customerHours' ||
        key === 'driverHours' ||
        key === 'extraChargesNotes' ||
        key === 'expenseNotes' ||
        key === 'paymentNotes' ||
        key === 'driverPayStatus' ||
        key === 'driverPayMethod' ||
        key === 'driverPaidAt'
          ? value
          : Number(value || 0),
    }));

  const money = (
    name: keyof FinanceFormValues & string,
    label: string,
    hint?: string,
  ) => (
    <FormField name={name} label={label} hint={hint} errors={errors[name]}>
      <Input
        {...fieldProps(name, errors[name])}
        type="number"
        min={0}
        step={1}
        disabled={readOnly}
        value={String(live[name] ?? 0)}
        onChange={(event) => set(name)(event.target.value)}
      />
    </FormField>
  );

  return (
    <form action={formAction} className="max-w-4xl space-y-8">
      {state.error ? (
        <Alert variant="destructive" data-testid="finance-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {readOnly ? (
        <Alert>
          <AlertDescription>
            Your role can see these figures but not change them.
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        All amounts are in pence, matching how they are stored. £125.50 is
        entered as 12550.
      </p>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Revenue
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {money('baseFarePence', 'Base fare', 'Pre-filled from the booking price.')}
          {money(
            'waitTimePence',
            'Wait time charge',
            waitMinutesFromEvents === null
              ? 'No arrival events recorded yet, so enter this by hand.'
              : `Driver waited ${waitMinutesFromEvents} minutes.`,
          )}
          {money('extraChargesPence', 'Extra charges')}
          <FormField
            name="waitMinutesBilled"
            label="Wait minutes billed"
            errors={errors.waitMinutesBilled}
          >
            <Input
              {...fieldProps('waitMinutesBilled', errors.waitMinutesBilled)}
              type="number"
              min={0}
              disabled={readOnly}
              value={String(live.waitMinutesBilled)}
              onChange={(event) => set('waitMinutesBilled')(event.target.value)}
            />
          </FormField>
          <FormField
            name="customerHours"
            label="Customer hours"
            hint="As-directed jobs only."
            errors={errors.customerHours}
          >
            <Input
              {...fieldProps('customerHours', errors.customerHours)}
              inputMode="decimal"
              disabled={readOnly}
              value={live.customerHours}
              onChange={(event) => set('customerHours')(event.target.value)}
            />
          </FormField>
          {money('customerRatePence', 'Customer hourly rate')}
        </div>
        <FormField
          name="extraChargesNotes"
          label="Extra charge notes"
          errors={errors.extraChargesNotes}
        >
          <Textarea
            {...fieldProps('extraChargesNotes', errors.extraChargesNotes)}
            rows={2}
            disabled={readOnly}
            value={live.extraChargesNotes}
            onChange={(event) => set('extraChargesNotes')(event.target.value)}
          />
        </FormField>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Costs
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {money(
            'driverPaymentPence',
            'Driver payment',
            'Pre-filled from the booking driver price.',
          )}
          {money('fuelCostPence', 'Fuel')}
          {money('otherExpensesPence', 'Other expenses')}
          <FormField
            name="driverHours"
            label="Driver hours"
            errors={errors.driverHours}
          >
            <Input
              {...fieldProps('driverHours', errors.driverHours)}
              inputMode="decimal"
              disabled={readOnly}
              value={live.driverHours}
              onChange={(event) => set('driverHours')(event.target.value)}
            />
          </FormField>
          {money('driverRatePence', 'Driver hourly rate')}
        </div>
        <FormField name="expenseNotes" label="Expense notes" errors={errors.expenseNotes}>
          <Textarea
            {...fieldProps('expenseNotes', errors.expenseNotes)}
            rows={2}
            disabled={readOnly}
            value={live.expenseNotes}
            onChange={(event) => set('expenseNotes')(event.target.value)}
          />
        </FormField>
      </section>

      {/* Read-only by construction: no name attributes, so none of it posts. */}
      <section
        className="space-y-2 rounded-lg border bg-muted/30 p-4"
        data-testid="finance-totals"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Totals
        </h2>
        <Total label="Revenue" value={pounds(totals.totalClientPence)} />
        <Total label="Costs" value={pounds(totals.totalCostsPence)} />
        <Total
          label="Gross profit"
          value={pounds(totals.grossProfitPence)}
          negative={totals.grossProfitPence < 0}
          emphasis
        />
        <Total
          label="Margin"
          value={totals.marginPct === null ? '—' : `${totals.marginPct.toFixed(1)}%`}
          negative={(totals.marginPct ?? 0) < 0}
        />
        <p className="pt-1 text-xs text-muted-foreground">
          Calculated here for feedback and recalculated on the server when you
          save. The figures you see are never what gets stored.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Driver settlement
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="driverPayStatus"
            label="Pay status"
            errors={errors.driverPayStatus}
          >
            <Select
              {...fieldProps('driverPayStatus', errors.driverPayStatus)}
              disabled={readOnly}
              value={live.driverPayStatus}
              onChange={(event) => set('driverPayStatus')(event.target.value)}
            >
              {PAY_STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            name="driverPayMethod"
            label="Pay method"
            errors={errors.driverPayMethod}
          >
            <Select
              {...fieldProps('driverPayMethod', errors.driverPayMethod)}
              disabled={readOnly}
              value={live.driverPayMethod}
              onChange={(event) => set('driverPayMethod')(event.target.value)}
            >
              <option value="">Not recorded</option>
              {PAY_METHODS.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField name="driverPaidAt" label="Paid on" errors={errors.driverPaidAt}>
            <Input
              {...fieldProps('driverPaidAt', errors.driverPaidAt)}
              type="date"
              disabled={readOnly}
              value={live.driverPaidAt}
              onChange={(event) => set('driverPaidAt')(event.target.value)}
            />
          </FormField>
        </div>

        <FormField name="paymentNotes" label="Payment notes" errors={errors.paymentNotes}>
          <Textarea
            {...fieldProps('paymentNotes', errors.paymentNotes)}
            rows={2}
            disabled={readOnly}
            value={live.paymentNotes}
            onChange={(event) => set('paymentNotes')(event.target.value)}
          />
        </FormField>
      </section>

      <div className="flex items-center gap-3 border-t pt-6">
        {readOnly ? null : <SubmitButton />}
        <Button asChild variant="ghost">
          <Link href={cancelHref}>{readOnly ? 'Back' : 'Cancel'}</Link>
        </Button>
      </div>
    </form>
  );
}

function Total({
  label,
  value,
  negative,
  emphasis,
}: {
  label: string;
  value: string;
  negative?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={[
          'tabular',
          emphasis ? 'text-base font-semibold' : '',
          negative ? 'text-destructive' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </span>
    </div>
  );
}
