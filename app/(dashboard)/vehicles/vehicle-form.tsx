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
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import {
  VEHICLE_CLASSES,
  VEHICLE_OWNERSHIPS,
  VEHICLE_STATUSES,
} from '@/lib/enum-options';

export interface DriverOption {
  id: string;
  name: string;
  reference: string;
}

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
  ownership: string;
  ownerDriverId: string;
  acquiredOn: string;
  disposedOn: string;
  purchasePrice: string;
  currentOdometer: string;
  lastServicedOn: string;
  lastServiceMiles: string;
  serviceEveryMonths: string;
  serviceEveryMiles: string;
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
  ownership: 'DRIVER_OWNED',
  ownerDriverId: '',
  acquiredOn: '',
  disposedOn: '',
  purchasePrice: '',
  currentOdometer: '',
  lastServicedOn: '',
  lastServiceMiles: '',
  serviceEveryMonths: '',
  serviceEveryMiles: '',
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
  drivers = [],
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: VehicleFormValues;
  submitLabel: string;
  cancelHref: string;
  drivers?: DriverOption[];
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};

  // Which questions are worth asking follows from who owns the car: a
  // driver's own car has an owner and no company costs, a company car has an
  // acquisition and a service schedule. Showing both at once asks the
  // operator to work out which half to ignore.
  const [ownership, setOwnership] = useState(values.ownership);
  const companyOwned = ownership !== 'DRIVER_OWNED';

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
            Ownership
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only a company car carries running costs. A driver&rsquo;s own car
            earns a margin and its repairs are its owner&rsquo;s.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="ownership" label="Held as" errors={errors.ownership}>
            <Select
              {...fieldProps('ownership', errors.ownership)}
              value={ownership}
              onChange={(event) => setOwnership(event.target.value)}
            >
              {VEHICLE_OWNERSHIPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>

          {companyOwned ? (
            <FormField
              name="purchasePrice"
              label="Purchase price"
              hint="What it cost to buy, if it was bought."
              errors={errors.purchasePrice}
            >
              <Input
                {...fieldProps('purchasePrice', errors.purchasePrice)}
                inputMode="decimal"
                placeholder="34500.00"
                defaultValue={values.purchasePrice}
                className="tabular"
              />
            </FormField>
          ) : (
            <FormField
              name="ownerDriverId"
              label="Whose car"
              hint="The owner-driver this car belongs to."
              errors={errors.ownerDriverId}
            >
              <Select
                {...fieldProps('ownerDriverId', errors.ownerDriverId)}
                defaultValue={values.ownerDriverId}
              >
                <option value="">Not recorded</option>
                {drivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.name} · {driver.reference}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>

        {companyOwned ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="acquiredOn"
              label="Acquired"
              errors={errors.acquiredOn}
            >
              <Input
                {...fieldProps('acquiredOn', errors.acquiredOn)}
                type="date"
                defaultValue={values.acquiredOn}
              />
            </FormField>

            <FormField
              name="disposedOn"
              label="Disposed of"
              hint="Leave blank while it is still on the fleet."
              errors={errors.disposedOn}
            >
              <Input
                {...fieldProps('disposedOn', errors.disposedOn)}
                type="date"
                defaultValue={values.disposedOn}
              />
            </FormField>
          </div>
        ) : null}

        {/* A collapsed field posts nothing, and nothing saves as null. Held
            here so switching a car to its driver's own — which is where these
            costs stop being the company's — does not also erase the record of
            what it cost and when it was last serviced. */}
        {companyOwned ? null : (
          <>
            <input
              type="hidden"
              name="purchasePrice"
              value={values.purchasePrice}
            />
            <input type="hidden" name="acquiredOn" value={values.acquiredOn} />
            <input type="hidden" name="disposedOn" value={values.disposedOn} />
            <input
              type="hidden"
              name="currentOdometer"
              value={values.currentOdometer}
            />
            <input
              type="hidden"
              name="lastServicedOn"
              value={values.lastServicedOn}
            />
            <input
              type="hidden"
              name="lastServiceMiles"
              value={values.lastServiceMiles}
            />
            <input
              type="hidden"
              name="serviceEveryMonths"
              value={values.serviceEveryMonths}
            />
            <input
              type="hidden"
              name="serviceEveryMiles"
              value={values.serviceEveryMiles}
            />
          </>
        )}
      </section>

      {companyOwned ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Servicing
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A service falls due at whichever comes first, the interval or the
              mileage. Blank intervals use the fleet defaults of 12 months and
              12,000 miles. An overdue service does not block assignment — that
              is a maintenance call, not a legal one.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              name="currentOdometer"
              label="Odometer"
              hint="Updated whenever a cost records a reading."
              errors={errors.currentOdometer}
            >
              <Input
                {...fieldProps('currentOdometer', errors.currentOdometer)}
                type="number"
                min={0}
                defaultValue={values.currentOdometer}
                className="tabular"
              />
            </FormField>

            <FormField
              name="lastServicedOn"
              label="Last serviced"
              errors={errors.lastServicedOn}
            >
              <Input
                {...fieldProps('lastServicedOn', errors.lastServicedOn)}
                type="date"
                defaultValue={values.lastServicedOn}
              />
            </FormField>

            <FormField
              name="lastServiceMiles"
              label="At mileage"
              errors={errors.lastServiceMiles}
            >
              <Input
                {...fieldProps('lastServiceMiles', errors.lastServiceMiles)}
                type="number"
                min={0}
                defaultValue={values.lastServiceMiles}
                className="tabular"
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="serviceEveryMonths"
              label="Service every (months)"
              errors={errors.serviceEveryMonths}
            >
              <Input
                {...fieldProps('serviceEveryMonths', errors.serviceEveryMonths)}
                type="number"
                min={1}
                placeholder="12"
                defaultValue={values.serviceEveryMonths}
                className="tabular"
              />
            </FormField>

            <FormField
              name="serviceEveryMiles"
              label="Service every (miles)"
              errors={errors.serviceEveryMiles}
            >
              <Input
                {...fieldProps('serviceEveryMiles', errors.serviceEveryMiles)}
                type="number"
                min={100}
                placeholder="12000"
                defaultValue={values.serviceEveryMiles}
                className="tabular"
              />
            </FormField>
          </div>
        </section>
      ) : null}

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
