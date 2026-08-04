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
import { DRIVER_STATUSES } from '@/lib/drivers';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

export interface DriverFormValues {
  name: string;
  phone: string;
  email: string;
  address: string;
  dvlaLicenceNumber: string;
  dvlaLicenceExpiry: string;
  phvBadgeNumber: string;
  phvBadgeExpiry: string;
  phvIssuingAuthority: string;
  assignedVehicleId: string;
  status: string;
  notes: string;
}

const BLANK: DriverFormValues = {
  name: '',
  phone: '',
  email: '',
  address: '',
  dvlaLicenceNumber: '',
  dvlaLicenceExpiry: '',
  phvBadgeNumber: '',
  phvBadgeExpiry: '',
  phvIssuingAuthority: '',
  assignedVehicleId: '',
  status: 'ACTIVE',
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

export function DriverForm({
  action,
  values = BLANK,
  vehicles,
  submitLabel,
  cancelHref,
  nextReference,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: DriverFormValues;
  vehicles: Array<{ id: string; registration: string; label: string }>;
  submitLabel: string;
  cancelHref: string;
  /** Shown on create so the operator knows the number before saving. */
  nextReference?: string;
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
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Who they are
          </h2>
          {nextReference ? (
            <p className="text-xs text-muted-foreground">
              Reference{' '}
              <span className="tabular font-medium">{nextReference}</span> —
              allocated on save, and fixed after that
            </p>
          ) : null}
        </div>

        <FormField name="name" label="Name" required errors={errors.name}>
          <Input
            {...fieldProps('name', errors.name)}
            defaultValue={values.name}
            required
            autoFocus
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="phone" label="Phone" required errors={errors.phone}>
            <Input
              {...fieldProps('phone', errors.phone)}
              type="tel"
              defaultValue={values.phone}
              required
            />
          </FormField>

          <FormField name="email" label="Email" errors={errors.email}>
            <Input
              {...fieldProps('email', errors.email)}
              type="email"
              defaultValue={values.email}
            />
          </FormField>
        </div>

        <FormField name="address" label="Address" errors={errors.address}>
          <Textarea
            {...fieldProps('address', errors.address)}
            defaultValue={values.address}
            rows={2}
          />
        </FormField>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Licensing
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Both expiry dates are what compliance is judged on. A driver with a
            date missing cannot be assigned to a job.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="dvlaLicenceNumber"
            label="DVLA licence number"
            errors={errors.dvlaLicenceNumber}
          >
            <Input
              {...fieldProps('dvlaLicenceNumber', errors.dvlaLicenceNumber)}
              defaultValue={values.dvlaLicenceNumber}
            />
          </FormField>

          <FormField
            name="dvlaLicenceExpiry"
            label="DVLA licence expires"
            errors={errors.dvlaLicenceExpiry}
          >
            <Input
              {...fieldProps('dvlaLicenceExpiry', errors.dvlaLicenceExpiry)}
              type="date"
              defaultValue={values.dvlaLicenceExpiry}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="phvBadgeNumber"
            label="PHV badge number"
            errors={errors.phvBadgeNumber}
          >
            <Input
              {...fieldProps('phvBadgeNumber', errors.phvBadgeNumber)}
              defaultValue={values.phvBadgeNumber}
            />
          </FormField>

          <FormField
            name="phvBadgeExpiry"
            label="PHV badge expires"
            errors={errors.phvBadgeExpiry}
          >
            <Input
              {...fieldProps('phvBadgeExpiry', errors.phvBadgeExpiry)}
              type="date"
              defaultValue={values.phvBadgeExpiry}
            />
          </FormField>
        </div>

        <FormField
          name="phvIssuingAuthority"
          label="Issuing authority"
          hint="TfL, or the local authority that issued the badge."
          errors={errors.phvIssuingAuthority}
        >
          <Input
            {...fieldProps('phvIssuingAuthority', errors.phvIssuingAuthority)}
            defaultValue={values.phvIssuingAuthority}
          />
        </FormField>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Assignment
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="assignedVehicleId"
            label="Assigned vehicle"
            hint="A job can still override this. Sharing a car with another driver is allowed."
            errors={errors.assignedVehicleId}
          >
            <Select
              {...fieldProps('assignedVehicleId', errors.assignedVehicleId)}
              defaultValue={values.assignedVehicleId}
            >
              <option value="">None</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            name="status"
            label="Status"
            hint="Deactivating warns if they hold upcoming jobs."
            errors={errors.status}
          >
            <Select
              {...fieldProps('status', errors.status)}
              defaultValue={values.status}
            >
              {DRIVER_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <FormField name="notes" label="Notes" errors={errors.notes}>
          <Textarea
            {...fieldProps('notes', errors.notes)}
            defaultValue={values.notes}
            rows={3}
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
