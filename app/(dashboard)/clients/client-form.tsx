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
import { VAT_TREATMENTS } from '@/lib/vat';
import { Textarea } from '@/components/ui/textarea';
import {
  INITIAL_CLIENT_FORM_STATE,
  type ClientFormState,
} from './form-state';

export interface ClientFormValues {
  name: string;
  contactPhone: string;
  contactChannel: string;
  contactEmail: string;
  billingEmail: string;
  billingAddress: string;
  vatNumber: string;
  paymentTermsDays: number;
  vatTreatment: string;
  defaultAccountId: string;
  notes: string;
}

const BLANK: ClientFormValues = {
  name: '',
  contactPhone: '',
  contactChannel: 'EMAIL',
  contactEmail: '',
  billingEmail: '',
  billingAddress: '',
  vatNumber: '',
  paymentTermsDays: 14,
  vatTreatment: 'STANDARD',
  defaultAccountId: '',
  notes: '',
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function ClientForm({
  action,
  values = BLANK,
  accounts,
  submitLabel,
  cancelHref,
  /** Only the roles that may edit billing get those fields enabled. */
  canEditAllFields,
}: {
  action: (
    state: ClientFormState,
    formData: FormData,
  ) => Promise<ClientFormState>;
  values?: ClientFormValues;
  accounts: Array<{ id: string; name: string }>;
  submitLabel: string;
  cancelHref: string;
  canEditAllFields: boolean;
}) {
  const [state, formAction] = useActionState(action, INITIAL_CLIENT_FORM_STATE);
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Who they are
        </h2>

        <FormField name="name" label="Name" required errors={errors.name}>
          <Input
            {...fieldProps('name', errors.name)}
            defaultValue={values.name}
            required
            disabled={!canEditAllFields}
            autoFocus
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="contactPhone"
            label="Contact phone"
            errors={errors.contactPhone}
          >
            <Input
              {...fieldProps('contactPhone', errors.contactPhone)}
              type="tel"
              defaultValue={values.contactPhone}
              disabled={!canEditAllFields}
            />
          </FormField>

          {/* Spec 5.10.4. Both this and the per-template setting have to say
              yes before anything is sent. */}
          <FormField
            name="contactChannel"
            label="Keep them informed by"
            hint="Booking confirmations and driver updates."
            errors={errors.contactChannel}
          >
            <Select
              {...fieldProps('contactChannel', errors.contactChannel)}
              defaultValue={values.contactChannel}
              disabled={!canEditAllFields}
            >
              <option value="EMAIL">Email</option>
              <option value="SMS">Text message</option>
              <option value="BOTH">Both</option>
              <option value="NONE">Nothing — they do not want to be contacted</option>
            </Select>
          </FormField>

          <FormField
            name="contactEmail"
            label="Contact email"
            errors={errors.contactEmail}
          >
            <Input
              {...fieldProps('contactEmail', errors.contactEmail)}
              type="email"
              defaultValue={values.contactEmail}
              disabled={!canEditAllFields}
            />
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Billing
        </h2>

        <FormField
          name="defaultAccountId"
          label="Default account"
          hint="The booker who usually gets invoiced for this client's work. The client rides; the account pays."
          errors={errors.defaultAccountId}
        >
          <Select
            {...fieldProps('defaultAccountId', errors.defaultAccountId)}
            defaultValue={values.defaultAccountId}
          >
            <option value="">None</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          name="billingEmail"
          label="Billing email"
          hint="Where invoices go, if different from the contact email."
          errors={errors.billingEmail}
        >
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
          <FormField
            name="vatNumber"
            label="VAT number"
            errors={errors.vatNumber}
          >
            <Input
              {...fieldProps('vatNumber', errors.vatNumber)}
              defaultValue={values.vatNumber}
            />
          </FormField>

          <FormField
            name="paymentTermsDays"
            label="Payment terms"
            hint="Days from invoice date."
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
            name="vatTreatment"
            label="VAT treatment"
            hint="How this client&rsquo;s work is normally charged. A job can override it."
            errors={errors.vatTreatment}
          >
            <Select
              {...fieldProps('vatTreatment', errors.vatTreatment)}
              defaultValue={values.vatTreatment}
            >
              {VAT_TREATMENTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <FormField name="notes" label="Notes" errors={errors.notes}>
          <Textarea
            {...fieldProps('notes', errors.notes)}
            defaultValue={values.notes}
            rows={3}
            disabled={!canEditAllFields}
          />
        </FormField>
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
