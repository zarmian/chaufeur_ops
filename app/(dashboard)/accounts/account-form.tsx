'use client';

import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ACCOUNT_KINDS } from '@/lib/accounts';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

export interface AccountFormValues {
  name: string;
  kind: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  billingEmail: string;
  billingAddress: string;
  vatNumber: string;
  paymentTermsDays: number;
  commissionPct: string;
  active: boolean;
}

const BLANK: AccountFormValues = {
  name: '',
  kind: 'CORPORATE',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  billingEmail: '',
  billingAddress: '',
  vatNumber: '',
  paymentTermsDays: 14,
  commissionPct: '',
  active: true,
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function AccountForm({
  action,
  values = BLANK,
  submitLabel,
  cancelHref,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: AccountFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};

  return (
    <form action={formAction} className="max-w-2xl space-y-8">
      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="name" label="Account name" required errors={errors.name}>
            <Input
              {...fieldProps('name', errors.name)}
              defaultValue={values.name}
              required
              autoFocus
            />
          </FormField>

          <FormField
            name="kind"
            label="Kind"
            hint="Internal is your own brand taking the booking."
            errors={errors.kind}
          >
            <Select {...fieldProps('kind', errors.kind)} defaultValue={values.kind}>
              {ACCOUNT_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="contactName" label="Contact name" errors={errors.contactName}>
            <Input
              {...fieldProps('contactName', errors.contactName)}
              defaultValue={values.contactName}
            />
          </FormField>

          <FormField name="contactPhone" label="Contact phone" errors={errors.contactPhone}>
            <Input
              {...fieldProps('contactPhone', errors.contactPhone)}
              type="tel"
              defaultValue={values.contactPhone}
            />
          </FormField>
        </div>

        <FormField name="contactEmail" label="Contact email" errors={errors.contactEmail}>
          <Input
            {...fieldProps('contactEmail', errors.contactEmail)}
            type="email"
            defaultValue={values.contactEmail}
          />
        </FormField>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Billing
        </h2>

        <FormField name="billingEmail" label="Billing email" errors={errors.billingEmail}>
          <Input
            {...fieldProps('billingEmail', errors.billingEmail)}
            type="email"
            defaultValue={values.billingEmail}
          />
        </FormField>

        <FormField
          name="billingAddress"
          label="Billing address"
          errors={errors.billingAddress}
        >
          <Textarea
            {...fieldProps('billingAddress', errors.billingAddress)}
            defaultValue={values.billingAddress}
            rows={3}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField name="vatNumber" label="VAT number" errors={errors.vatNumber}>
            <Input
              {...fieldProps('vatNumber', errors.vatNumber)}
              defaultValue={values.vatNumber}
            />
          </FormField>

          <FormField
            name="paymentTermsDays"
            label="Payment terms"
            hint="Days."
            errors={errors.paymentTermsDays}
          >
            <Input
              {...fieldProps('paymentTermsDays', errors.paymentTermsDays)}
              type="number"
              min={0}
              max={365}
              defaultValue={values.paymentTermsDays}
              className="tabular"
            />
          </FormField>

          <FormField
            name="commissionPct"
            label="Commission %"
            hint="Agency margin. A percentage, not money."
            errors={errors.commissionPct}
          >
            <Input
              {...fieldProps('commissionPct', errors.commissionPct)}
              type="number"
              step="0.01"
              min={0}
              max={100}
              defaultValue={values.commissionPct}
              className="tabular"
            />
          </FormField>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="active"
            defaultChecked={values.active}
            className="size-4 rounded border-input"
          />
          Active — available when booking a job
        </label>
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton label={submitLabel} />
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
