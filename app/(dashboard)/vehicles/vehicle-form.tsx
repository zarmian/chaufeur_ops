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
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import { VEHICLE_CLASSES, VEHICLE_STATUSES } from '@/lib/enum-options';

export interface VehicleFormValues {
  registration: string;
  make: string;
  model: string;
  variant: string;
  vehicleClass: string;
  colour: string;
  seats: number;
  phvLicenceNumber: string;
  phvLicenceExpiry: string;
  motExpiry: string;
  insuranceExpiry: string;
  insurancePolicyNo: string;
  status: string;
}

const BLANK: VehicleFormValues = {
  registration: '',
  make: '',
  model: '',
  variant: '',
  vehicleClass: 'EXECUTIVE',
  colour: '',
  seats: 4,
  phvLicenceNumber: '',
  phvLicenceExpiry: '',
  motExpiry: '',
  insuranceExpiry: '',
  insurancePolicyNo: '',
  status: 'ACTIVE',
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function VehicleForm({
  action,
  values = BLANK,
  submitLabel,
  cancelHref,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: VehicleFormValues;
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          The car
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="registration"
            label="Registration"
            required
            hint="Spacing and case do not matter for matching."
            errors={errors.registration}
          >
            <Input
              {...fieldProps('registration', errors.registration)}
              defaultValue={values.registration}
              required
              autoFocus
              className="uppercase tabular"
            />
          </FormField>

          <FormField name="status" label="Status" errors={errors.status}>
            <Select
              {...fieldProps('status', errors.status)}
              defaultValue={values.status}
            >
              {VEHICLE_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="make" label="Make" required errors={errors.make}>
            <Input
              {...fieldProps('make', errors.make)}
              defaultValue={values.make}
              required
            />
          </FormField>

          <FormField name="model" label="Model" required errors={errors.model}>
            <Input
              {...fieldProps('model', errors.model)}
              defaultValue={values.model}
              required
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField name="variant" label="Variant" errors={errors.variant}>
            <Input
              {...fieldProps('variant', errors.variant)}
              defaultValue={values.variant}
            />
          </FormField>

          <FormField name="colour" label="Colour" errors={errors.colour}>
            <Input
              {...fieldProps('colour', errors.colour)}
              defaultValue={values.colour}
            />
          </FormField>

          <FormField name="seats" label="Seats" errors={errors.seats}>
            <Input
              {...fieldProps('seats', errors.seats)}
              type="number"
              min={1}
              max={16}
              defaultValue={values.seats}
              className="tabular"
            />
          </FormField>
        </div>

        <FormField
          name="vehicleClass"
          label="Class"
          hint="Drives rate card matching in Phase 4."
          errors={errors.vehicleClass}
        >
          <Select
            {...fieldProps('vehicleClass', errors.vehicleClass)}
            defaultValue={values.vehicleClass}
          >
            {VEHICLE_CLASSES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Compliance
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A missing date counts as non-compliant, not as valid — the vehicle
            cannot be assigned to a job until it is recorded.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="motExpiry" label="MOT expires" errors={errors.motExpiry}>
            <Input
              {...fieldProps('motExpiry', errors.motExpiry)}
              type="date"
              defaultValue={values.motExpiry}
            />
          </FormField>

          <FormField
            name="insuranceExpiry"
            label="Insurance expires"
            errors={errors.insuranceExpiry}
          >
            <Input
              {...fieldProps('insuranceExpiry', errors.insuranceExpiry)}
              type="date"
              defaultValue={values.insuranceExpiry}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="insurancePolicyNo"
            label="Insurance policy number"
            errors={errors.insurancePolicyNo}
          >
            <Input
              {...fieldProps('insurancePolicyNo', errors.insurancePolicyNo)}
              defaultValue={values.insurancePolicyNo}
            />
          </FormField>

          <FormField
            name="phvLicenceExpiry"
            label="PHV vehicle licence expires"
            errors={errors.phvLicenceExpiry}
          >
            <Input
              {...fieldProps('phvLicenceExpiry', errors.phvLicenceExpiry)}
              type="date"
              defaultValue={values.phvLicenceExpiry}
            />
          </FormField>
        </div>

        <FormField
          name="phvLicenceNumber"
          label="PHV vehicle licence number"
          errors={errors.phvLicenceNumber}
        >
          <Input
            {...fieldProps('phvLicenceNumber', errors.phvLicenceNumber)}
            defaultValue={values.phvLicenceNumber}
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
