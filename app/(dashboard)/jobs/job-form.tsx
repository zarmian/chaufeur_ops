'use client';

import { AlertCircle, AlertTriangle, BadgePoundSterling } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { JOB_TYPES } from '@/lib/enum-options';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

/**
 * The booking form.
 *
 * The single most important thing about this component is that **Client price
 * and Driver price are fields on the form**, in their own section, above the
 * fold — not behind a "finances" modal. The legacy system put them behind a
 * modal and 140 of 141 jobs came out worth £0.
 *
 * Submitting without a client price is still allowed, because a real booking
 * sometimes arrives before its price does and refusing it would push people
 * back to a spreadsheet. But it takes a deliberate second click, and the
 * warning says exactly what the consequence is.
 */

export interface JobFormValues {
  clientId: string;
  accountId: string;
  jobType: string;
  scheduledDate: string;
  scheduledTime: string;
  pickupText: string;
  dropoffText: string;
  viaText: string;
  driverId: string;
  vehicleId: string;
  passengerName: string;
  passengerPhone: string;
  passengerCount: number | string;
  luggageCount: number | string;
  flightNumber: string;
  clientPrice: string;
  driverPrice: string;
  notes: string;
  internalNotes: string;
}

const BLANK: JobFormValues = {
  clientId: '',
  accountId: '',
  jobType: 'TRANSFER',
  scheduledDate: '',
  scheduledTime: '',
  pickupText: '',
  dropoffText: '',
  viaText: '',
  driverId: '',
  vehicleId: '',
  passengerName: '',
  passengerPhone: '',
  passengerCount: '',
  luggageCount: '',
  flightNumber: '',
  clientPrice: '',
  driverPrice: '',
  notes: '',
  internalNotes: '',
};

export interface JobFormOption {
  id: string;
  label: string;
}

export interface DriverOption extends JobFormOption {
  /** Pre-selects the vehicle when a driver is chosen (spec 2.1.4). */
  assignedVehicleId: string | null;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function JobForm({
  action,
  values = BLANK,
  submitLabel,
  cancelHref,
  clients,
  accounts,
  drivers,
  vehicles,
  locations,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: JobFormValues;
  submitLabel: string;
  cancelHref: string;
  clients: JobFormOption[];
  accounts: JobFormOption[];
  drivers: DriverOption[];
  vehicles: JobFormOption[];
  locations: string[];
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};

  const [jobType, setJobType] = useState(values.jobType);
  const [driverId, setDriverId] = useState(values.driverId);
  const [vehicleId, setVehicleId] = useState(values.vehicleId);
  const [clientPrice, setClientPrice] = useState(values.clientPrice);
  const [confirmedUnpriced, setConfirmedUnpriced] = useState(false);

  const isAirport = jobType === 'AIRPORT_TRANSFER';
  const isHourly = jobType === 'AS_DIRECTED';

  // Blank means "nobody has said", which is the state worth warning about. A
  // typed 0 is a deliberate statement and gets a zero-value reason instead.
  const priceMissing = clientPrice.trim() === '';
  const needsConfirmation = priceMissing && !confirmedUnpriced;

  /** Choosing a driver defaults the vehicle, but never locks it. */
  function onDriverChange(nextDriverId: string) {
    setDriverId(nextDriverId);
    const driver = drivers.find((d) => d.id === nextDriverId);
    if (driver?.assignedVehicleId) setVehicleId(driver.assignedVehicleId);
  }

  return (
    <form action={formAction} className="max-w-4xl space-y-8">
      {state.error ? (
        <Alert variant="destructive" data-testid="form-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <datalist id="saved-locations">
        {locations.map((location) => (
          <option key={location} value={location} />
        ))}
      </datalist>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Booking
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="clientId" label="Client" errors={errors.clientId}>
            <Select {...fieldProps('clientId', errors.clientId)} defaultValue={values.clientId}>
              <option value="">No client recorded</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            name="accountId"
            label="Account"
            hint="Who gets invoiced. Often not the person riding."
            errors={errors.accountId}
          >
            <Select {...fieldProps('accountId', errors.accountId)} defaultValue={values.accountId}>
              <option value="">No account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField name="jobType" label="Job type" required errors={errors.jobType}>
            <Select
              {...fieldProps('jobType', errors.jobType)}
              value={jobType}
              onChange={(event) => setJobType(event.target.value)}
            >
              {JOB_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              name="scheduledDate"
              label="Date"
              required
              errors={errors.scheduledDate}
            >
              <Input
                {...fieldProps('scheduledDate', errors.scheduledDate)}
                type="date"
                required
                defaultValue={values.scheduledDate}
              />
            </FormField>
            <FormField
              name="scheduledTime"
              label="Time"
              required
              hint="Local time"
              errors={errors.scheduledTime}
            >
              <Input
                {...fieldProps('scheduledTime', errors.scheduledTime)}
                type="time"
                required
                defaultValue={values.scheduledTime}
              />
            </FormField>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Route
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="pickupText" label="Pickup" required errors={errors.pickupText}>
            <Input
              {...fieldProps('pickupText', errors.pickupText)}
              required
              autoFocus
              list="saved-locations"
              defaultValue={values.pickupText}
              placeholder="The Dorchester"
            />
          </FormField>

          <FormField
            name="dropoffText"
            label="Destination"
            required
            errors={errors.dropoffText}
          >
            <Input
              {...fieldProps('dropoffText', errors.dropoffText)}
              required
              list="saved-locations"
              defaultValue={values.dropoffText}
              placeholder="Heathrow Terminal 5"
            />
          </FormField>

          <FormField name="viaText" label="Via" errors={errors.viaText}>
            <Input
              {...fieldProps('viaText', errors.viaText)}
              list="saved-locations"
              defaultValue={values.viaText}
            />
          </FormField>

          {isAirport ? (
            <FormField
              name="flightNumber"
              label="Flight number"
              hint="Used to track the arrival time."
              errors={errors.flightNumber}
            >
              <Input
                {...fieldProps('flightNumber', errors.flightNumber)}
                defaultValue={values.flightNumber}
                placeholder="BA286"
              />
            </FormField>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Driver and vehicle
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="driverId"
            label="Driver"
            hint="Expired documents are refused when the job is assigned."
            errors={errors.driverId}
          >
            <Select
              {...fieldProps('driverId', errors.driverId)}
              value={driverId}
              onChange={(event) => onDriverChange(event.target.value)}
            >
              <option value="">Unassigned</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            name="vehicleId"
            label="Vehicle"
            hint="Defaults to the driver's assigned car; change it if they are in another."
            errors={errors.vehicleId}
          >
            <Select
              {...fieldProps('vehicleId', errors.vehicleId)}
              value={vehicleId}
              onChange={(event) => setVehicleId(event.target.value)}
            >
              <option value="">No vehicle</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </section>

      {/*
        The section this whole phase exists for. Kept in the normal flow of
        the form, with its own heading, so it cannot be skipped the way a
        modal can.
      */}
      <section className="space-y-4 rounded-lg border border-primary/30 bg-primary/[0.03] p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <BadgePoundSterling className="size-4" aria-hidden />
          Price
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="clientPrice"
            label="Client price"
            hint={
              isHourly
                ? 'The agreed total. Hourly rates are set in the finance panel.'
                : 'The fare agreed with whoever booked it.'
            }
            errors={errors.clientPricePence}
          >
            <Input
              {...fieldProps('clientPrice', errors.clientPricePence)}
              inputMode="decimal"
              placeholder="125.50"
              value={clientPrice}
              onChange={(event) => {
                setClientPrice(event.target.value);
                setConfirmedUnpriced(false);
              }}
            />
          </FormField>

          <FormField
            name="driverPrice"
            label="Driver price"
            hint="What the driver is paid for this job."
            errors={errors.driverPricePence}
          >
            <Input
              {...fieldProps('driverPrice', errors.driverPricePence)}
              inputMode="decimal"
              placeholder="80.00"
              defaultValue={values.driverPrice}
            />
          </FormField>
        </div>

        {needsConfirmation ? (
          <Alert variant="warning" data-testid="unpriced-warning">
            <AlertTriangle aria-hidden />
            <AlertTitle>This job has no price</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>Jobs without prices don&apos;t appear in revenue reports.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmedUnpriced(true)}
              >
                Save without a price
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Passenger
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="passengerName"
            label="Passenger name"
            hint="Only when it is not the client."
            errors={errors.passengerName}
          >
            <Input
              {...fieldProps('passengerName', errors.passengerName)}
              defaultValue={values.passengerName}
            />
          </FormField>

          <FormField name="passengerPhone" label="Passenger phone" errors={errors.passengerPhone}>
            <Input
              {...fieldProps('passengerPhone', errors.passengerPhone)}
              type="tel"
              defaultValue={values.passengerPhone}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField name="passengerCount" label="Passengers" errors={errors.passengerCount}>
              <Input
                {...fieldProps('passengerCount', errors.passengerCount)}
                type="number"
                min={0}
                max={99}
                defaultValue={values.passengerCount}
              />
            </FormField>
            <FormField name="luggageCount" label="Luggage" errors={errors.luggageCount}>
              <Input
                {...fieldProps('luggageCount', errors.luggageCount)}
                type="number"
                min={0}
                max={99}
                defaultValue={values.luggageCount}
              />
            </FormField>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </h2>

        <FormField
          name="notes"
          label="Notes"
          hint="Visible to the driver."
          errors={errors.notes}
        >
          <Textarea
            {...fieldProps('notes', errors.notes)}
            rows={3}
            defaultValue={values.notes}
          />
        </FormField>

        <FormField
          name="internalNotes"
          label="Internal notes"
          hint="Office only. Never shown to the driver."
          errors={errors.internalNotes}
        >
          <Textarea
            {...fieldProps('internalNotes', errors.internalNotes)}
            rows={3}
            defaultValue={values.internalNotes}
          />
        </FormField>
      </section>

      <div className="flex items-center gap-3 border-t pt-6">
        {/* Disabled until the warning is acknowledged, so an unpriced save is
            always a deliberate second action rather than a slip. */}
        {needsConfirmation ? (
          <Button type="button" disabled title="Confirm the price warning first">
            {submitLabel}
          </Button>
        ) : (
          <SubmitButton label={submitLabel} />
        )}
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
