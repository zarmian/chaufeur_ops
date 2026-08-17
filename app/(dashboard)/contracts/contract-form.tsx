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
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from '@/lib/locale';
import { VAT_TREATMENTS } from '@/lib/vat';

/**
 * A standing arrangement, not a booking.
 *
 * The form asks what a day looks like and what a day is worth. It does not ask
 * for an end date beyond an optional one, because most of these run until
 * somebody stops them — and it says plainly that the driver and the car are
 * who normally does it rather than who is tied to it, since that is the
 * question an operator would otherwise have to guess the answer to.
 */

export interface ContractFormValues {
  label: string;
  clientId: string;
  accountId: string;
  pickupText: string;
  dropoffText: string;
  viaText: string;
  startTime: string;
  estimatedMinutes: string;
  passengerName: string;
  passengerPhone: string;
  driverId: string;
  vehicleId: string;
  weekdays: number[];
  startsOn: string;
  endsOn: string;
  dayRate: string;
  driverDayRate: string;
  vatTreatment: string;
  generateAheadDays: string;
  notes: string;
}

const BLANK: ContractFormValues = {
  label: '',
  clientId: '',
  accountId: '',
  pickupText: '',
  dropoffText: '',
  viaText: '',
  startTime: '09:00',
  estimatedMinutes: '',
  passengerName: '',
  passengerPhone: '',
  driverId: '',
  vehicleId: '',
  weekdays: [],
  startsOn: '',
  endsOn: '',
  dayRate: '',
  driverDayRate: '',
  vatTreatment: '',
  generateAheadDays: '14',
  notes: '',
};

/** 0 = Sunday, matching the stored list and `Date.getUTCDay`. */
const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

export interface Option {
  id: string;
  label: string;
}

export function ContractForm({
  action,
  values = BLANK,
  submitLabel,
  cancelHref,
  clients,
  accounts,
  drivers,
  vehicles,
  currency = DEFAULT_CURRENCY,
  locale: localeTag = DEFAULT_LOCALE,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: ContractFormValues;
  submitLabel: string;
  cancelHref: string;
  clients: Option[];
  accounts: Option[];
  drivers: Option[];
  vehicles: Option[];
  currency?: string;
  locale?: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};

  const [weekdays, setWeekdays] = useState<number[]>(values.weekdays);
  const [dayRate, setDayRate] = useState(values.dayRate);
  const [driverDayRate, setDriverDayRate] = useState(values.driverDayRate);

  const money = new Intl.NumberFormat(localeTag, {
    style: 'currency',
    currency,
  });

  const client = Number(dayRate);
  const driver = Number(driverDayRate);
  const marginPerDay =
    Number.isFinite(client) && client > 0 && Number.isFinite(driver)
      ? client - driver
      : null;

  const toggle = (day: number) =>
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((value) => value !== day)
        : [...current, day],
    );

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
          The arrangement
        </h2>

        <FormField
          name="label"
          label="Name"
          required
          hint="What it is called between you — “Aldridge school run”."
          errors={errors.label}
        >
          <Input
            {...fieldProps('label', errors.label)}
            defaultValue={values.label}
            required
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="accountId" label="Billed to" errors={errors.accountId}>
            <Select
              {...fieldProps('accountId', errors.accountId)}
              defaultValue={values.accountId}
            >
              <option value="">—</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            name="clientId"
            label="…or to client"
            hint="Every day it makes has to be billable to somebody."
            errors={errors.clientId}
          >
            <Select
              {...fieldProps('clientId', errors.clientId)}
              defaultValue={values.clientId}
            >
              <option value="">—</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What each day looks like
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="pickupText" label="Pick up" required errors={errors.pickupText}>
            <Input
              {...fieldProps('pickupText', errors.pickupText)}
              defaultValue={values.pickupText}
              required
            />
          </FormField>
          <FormField
            name="dropoffText"
            label="Drop off"
            required
            errors={errors.dropoffText}
          >
            <Input
              {...fieldProps('dropoffText', errors.dropoffText)}
              defaultValue={values.dropoffText}
              required
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            name="startTime"
            label="Pickup time"
            required
            hint="The same clock time every day, so it does not drift an hour in October."
            errors={errors.startTime}
          >
            <Input
              {...fieldProps('startTime', errors.startTime)}
              type="time"
              defaultValue={values.startTime}
              required
            />
          </FormField>
          <FormField
            name="estimatedMinutes"
            label="Takes about (minutes)"
            errors={errors.estimatedMinutes}
          >
            <Input
              {...fieldProps('estimatedMinutes', errors.estimatedMinutes)}
              type="number"
              min={0}
              placeholder="45"
              defaultValue={values.estimatedMinutes}
            />
          </FormField>
          <FormField name="viaText" label="Via" errors={errors.viaText}>
            <Input
              {...fieldProps('viaText', errors.viaText)}
              defaultValue={values.viaText}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="passengerName"
            label="Passenger"
            errors={errors.passengerName}
          >
            <Input
              {...fieldProps('passengerName', errors.passengerName)}
              defaultValue={values.passengerName}
            />
          </FormField>
          <FormField
            name="passengerPhone"
            label="Passenger number"
            errors={errors.passengerPhone}
          >
            <Input
              {...fieldProps('passengerPhone', errors.passengerPhone)}
              type="tel"
              defaultValue={values.passengerPhone}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="driverId"
            label="Usual driver"
            hint="Copied onto each day and changeable there. Nothing stops them doing other work."
            errors={errors.driverId}
          >
            <Select
              {...fieldProps('driverId', errors.driverId)}
              defaultValue={values.driverId}
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
            label="Usual vehicle"
            hint="Same — it is free for other jobs."
            errors={errors.vehicleId}
          >
            <Select
              {...fieldProps('vehicleId', errors.vehicleId)}
              defaultValue={values.vehicleId}
            >
              <option value="">Unassigned</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          When it runs
        </h2>

        <div>
          <p className="mb-2 text-sm font-medium">Days</p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((day) => (
              <label
                key={day.value}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  name="weekdays"
                  value={day.value}
                  checked={weekdays.includes(day.value)}
                  onChange={() => toggle(day.value)}
                  className="size-4"
                />
                {day.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Tick none for every day, including weekends.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField name="startsOn" label="Starts" required errors={errors.startsOn}>
            <Input
              {...fieldProps('startsOn', errors.startsOn)}
              type="date"
              defaultValue={values.startsOn}
              required
            />
          </FormField>
          <FormField
            name="endsOn"
            label="Ends"
            hint="Leave blank — most of these run until they are stopped."
            errors={errors.endsOn}
          >
            <Input
              {...fieldProps('endsOn', errors.endsOn)}
              type="date"
              defaultValue={values.endsOn}
            />
          </FormField>
          <FormField
            name="generateAheadDays"
            label="Book ahead (days)"
            hint="How far in advance days appear on the board."
            errors={errors.generateAheadDays}
          >
            <Input
              {...fieldProps('generateAheadDays', errors.generateAheadDays)}
              type="number"
              min={1}
              max={90}
              defaultValue={values.generateAheadDays}
            />
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What a day is worth
        </h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            name="dayRate"
            label="Day rate"
            required
            hint="Charged for each day this runs."
            errors={errors.dayRatePence}
          >
            <Input
              {...fieldProps('dayRate', errors.dayRatePence)}
              inputMode="decimal"
              placeholder="400.00"
              value={dayRate}
              onChange={(event) => setDayRate(event.target.value)}
              required
            />
          </FormField>
          <FormField
            name="driverDayRate"
            label="Driver day rate"
            errors={errors.driverDayRatePence}
          >
            <Input
              {...fieldProps('driverDayRate', errors.driverDayRatePence)}
              inputMode="decimal"
              placeholder="180.00"
              value={driverDayRate}
              onChange={(event) => setDriverDayRate(event.target.value)}
            />
          </FormField>
          <FormField
            name="vatTreatment"
            label="VAT"
            hint="Blank follows whoever is billed."
            errors={errors.vatTreatment}
          >
            <Select
              {...fieldProps('vatTreatment', errors.vatTreatment)}
              defaultValue={values.vatTreatment}
            >
              <option value="">As the booker is charged</option>
              {VAT_TREATMENTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        {marginPerDay !== null ? (
          <p className="text-sm" data-testid="contract-margin">
            <span className="text-muted-foreground">Gross profit per day: </span>
            <span
              className={
                marginPerDay < 0 ? 'font-semibold text-destructive' : 'font-semibold'
              }
            >
              {money.format(marginPerDay)}
            </span>
          </p>
        ) : null}
      </section>

      <FormField name="notes" label="Notes" errors={errors.notes}>
        <Textarea
          {...fieldProps('notes', errors.notes)}
          rows={3}
          defaultValue={values.notes}
        />
      </FormField>

      <div className="flex items-center gap-3 border-t pt-6">
        <SubmitButton label={submitLabel} />
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}
