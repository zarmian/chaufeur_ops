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
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import { RATE_TYPE_LABELS } from '@/lib/rentals';

/**
 * Booking a car out.
 *
 * The mileage and fuel readings are on the booking form rather than a
 * separate handover screen, because they are taken at the moment the keys
 * change hands — asking for them later means they get guessed.
 */
export function RentalForm({
  action,
  vehicles,
  drivers,
  cancelHref,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  vehicles: Array<{ id: string; label: string }>;
  drivers: Array<{ id: string; label: string }>;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};

  return (
    <form action={formAction} className="max-w-3xl space-y-8">
      {state.error ? (
        <Alert variant="destructive" data-testid="form-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          The hire
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="vehicleId" label="Vehicle" required errors={errors.vehicleId}>
            <Select {...fieldProps('vehicleId', errors.vehicleId)} required>
              <option value="">Choose a vehicle</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField name="driverId" label="Renting to" required errors={errors.driverId}>
            <Select {...fieldProps('driverId', errors.driverId)} required>
              <option value="">Choose a driver</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField name="startAt" label="Goes out" required errors={errors.startAt}>
            <Input
              {...fieldProps('startAt', errors.startAt)}
              type="datetime-local"
              required
            />
          </FormField>

          <FormField name="endAt" label="Due back" required errors={errors.endAt}>
            <Input {...fieldProps('endAt', errors.endAt)} type="datetime-local" required />
          </FormField>

          <FormField name="rateType" label="Charged" errors={errors.rateType}>
            <Select {...fieldProps('rateType', errors.rateType)} defaultValue="DAILY">
              {Object.entries(RATE_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            name="rate"
            label="Rate"
            required
            hint="Part periods round up — an extra hour on a daily hire is another day."
            errors={errors.ratePence}
          >
            <Input
              {...fieldProps('rate', errors.ratePence)}
              inputMode="decimal"
              placeholder="80.00"
              required
            />
          </FormField>

          <FormField
            name="deposit"
            label="Deposit taken"
            hint="Held against damage. Never counted toward the hire."
            errors={errors.depositPence}
          >
            <Input
              {...fieldProps('deposit', errors.depositPence)}
              inputMode="decimal"
              placeholder="300.00"
            />
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          At collection
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="mileageOut" label="Mileage" errors={errors.mileageOut}>
            <Input
              {...fieldProps('mileageOut', errors.mileageOut)}
              type="number"
              min={0}
              placeholder="41200"
            />
          </FormField>
          <FormField
            name="fuelOutPct"
            label="Fuel or charge (%)"
            errors={errors.fuelOutPct}
          >
            <Input
              {...fieldProps('fuelOutPct', errors.fuelOutPct)}
              type="number"
              min={0}
              max={100}
              placeholder="100"
            />
          </FormField>
        </div>
        <p className="text-sm text-muted-foreground">
          The handover checklist is created with the rental. Work through it
          with the driver at the car.
        </p>
      </section>

      <FormField name="notes" label="Notes" errors={errors.notes}>
        <Textarea {...fieldProps('notes', errors.notes)} rows={3} />
      </FormField>

      <div className="flex items-center gap-3 border-t pt-6">
        <SubmitButton />
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Book the car out'}
    </Button>
  );
}
