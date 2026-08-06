'use client';

import {
  AlertCircle,
  AlertTriangle,
  BadgePoundSterling,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { AddressField } from '@/components/address-field';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { JOB_TYPES } from '@/lib/enum-options';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import { billedHours } from '@/lib/job-finance';
import {
  fetchQuote,
  penceToField,
  quoteIsWorthAsking,
  type Quote,
} from '@/lib/pricing/quote-client';
import { StopsField, type StopValue } from './stops-field';

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
  pickupPostcode: string;
  pickupLat: string;
  pickupLng: string;
  dropoffText: string;
  dropoffPostcode: string;
  dropoffLat: string;
  dropoffLng: string;
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
  customerHours: string;
  customerRate: string;
  minimumHours: string;
  shiftId: string;
  stops: StopValue[];
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
  pickupPostcode: '',
  pickupLat: '',
  pickupLng: '',
  dropoffText: '',
  dropoffPostcode: '',
  dropoffLat: '',
  dropoffLng: '',
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
  customerHours: '',
  customerRate: '',
  minimumHours: '',
  shiftId: '',
  stops: [],
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

export interface VehicleOption extends JobFormOption {
  /** The rate card matches on it, so the form has to know it. */
  vehicleClass: string;
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
  openShifts = [],
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values?: JobFormValues;
  submitLabel: string;
  cancelHref: string;
  clients: JobFormOption[];
  accounts: JobFormOption[];
  drivers: DriverOption[];
  vehicles: VehicleOption[];
  locations: string[];
  /** Shifts currently open, for attributing a hired driver's job. */
  openShifts?: JobFormOption[];
}) {
  const [state, formAction, submitting] = useActionState(
    action,
    INITIAL_FORM_STATE,
  );
  const errors = state.fields ?? {};

  const [jobType, setJobType] = useState(values.jobType);
  const [driverId, setDriverId] = useState(values.driverId);
  const [vehicleId, setVehicleId] = useState(values.vehicleId);
  const [clientPrice, setClientPrice] = useState(values.clientPrice);
  const [driverPrice, setDriverPrice] = useState(values.driverPrice);
  const [confirmedUnpriced, setConfirmedUnpriced] = useState(false);
  const [customerHours, setCustomerHours] = useState(values.customerHours);
  const [customerRate, setCustomerRate] = useState(values.customerRate);
  const [minimumHours, setMinimumHours] = useState(values.minimumHours);

  /**
   * The rate card's answer — spec 4.2.7.
   *
   * The fields the quote depends on stay **uncontrolled**. Making them
   * controlled re-renders the whole form on every keystroke, and this form
   * submits through a Server Action: a render landing inside the action's
   * transition swallows the submit, and the operator sees a Book button that
   * did nothing. So the values are read off the form when one of them loses
   * focus, and `revision` is the only thing that changes.
   *
   * Blur is a better trigger anyway. Asking on every keystroke made the
   * suggested price flicker while somebody was still typing the address.
   */
  const formRef = useRef<HTMLFormElement>(null);
  const [revision, setRevision] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  /**
   * What the rate card put in each field.
   *
   * Kept as the *value* rather than a boolean, so a field still holding
   * exactly what was suggested is marked and one the operator has since
   * changed is not — spec 4.2.7's "visible marker with full manual override".
   * The original travels to the server as a hidden field so the audit entry
   * records what was suggested alongside what was saved (4.2.8).
   */
  const [suggestedClient, setSuggestedClient] = useState('');
  const [suggestedDriver, setSuggestedDriver] = useState('');

  const isAirport = jobType === 'AIRPORT_TRANSFER';
  const isHourly = jobType === 'AS_DIRECTED';

  const vehicleClass =
    vehicles.find((vehicle) => vehicle.id === vehicleId)?.vehicleClass ?? null;

  /**
   * Ask the rate card whenever the booking changes enough to matter.
   *
   * Debounced, because this fires while somebody is still typing an address,
   * and aborted on the next change so a slow answer to an old question cannot
   * arrive after a fast answer to the new one and overwrite it.
   */
  const askedFor = useRef('');

  /**
   * Set the instant Book is pressed, before React starts the action.
   *
   * `submitting` from `useActionState` only becomes true once the transition
   * has begun, which is a render too late: a debounced quote scheduled
   * moments earlier can still fire in between, and a `setState` landing
   * inside the action's transition restarts it — the form sits there having
   * apparently done nothing. An operator who types an address and clicks Book
   * within the debounce window sees exactly that.
   *
   * A ref rather than state, because the guard has to hold synchronously in
   * the submit handler and be readable by a callback that resolves later.
   */
  const submitted = useRef(false);
  const pendingQuote = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const field = (name: string) =>
      String(new FormData(form).get(name) ?? '');

    const input = {
      jobType,
      vehicleClass,
      accountId: field('accountId') || null,
      clientId: field('clientId') || null,
      pickupText: field('pickupText'),
      dropoffText: field('dropoffText'),
      // Present only once a suggestion has been chosen. The matcher resolves
      // a zone from a postcode where the typed text names none.
      pickupPostcode: field('pickupTextPostcode') || null,
      dropoffPostcode: field('dropoffTextPostcode') || null,
      scheduledDate: field('scheduledDate'),
      scheduledTime: field('scheduledTime'),
      hours: customerHours.trim() === '' ? null : Number(customerHours),
    };

    if (submitted.current || submitting) return;

    if (!quoteIsWorthAsking(input)) {
      setQuote(null);
      return;
    }

    const key = JSON.stringify(input);
    if (key === askedFor.current) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (submitted.current) return;
      askedFor.current = key;
      const suggestion = await fetchQuote(input, controller.signal);
      // Checked again on the way back: the submit may have started while the
      // request was in flight, and a late answer must not touch state then.
      if (controller.signal.aborted || submitted.current) return;

      setQuote(suggestion);
      if (!suggestion) return;

      // Only fill a field the operator has not put something in. Overwriting
      // a typed price with a suggested one is how an agreed fare silently
      // becomes the wrong number.
      const client = penceToField(suggestion.clientPricePence);
      setClientPrice((current) => {
        if (current.trim() === '' || current === suggestedClient) {
          setSuggestedClient(client);
          return client;
        }
        return current;
      });

      const driver = penceToField(suggestion.driverPricePence);
      if (driver) {
        setDriverPrice((current) => {
          if (current.trim() === '' || current === suggestedDriver) {
            setSuggestedDriver(driver);
            return driver;
          }
          return current;
        });
      }
    }, 400);

    pendingQuote.current = timer;

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `suggestedClient` and `suggestedDriver` are read inside the setters
    // rather than depended on: including them would re-run the effect every
    // time it fills a field, which is a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jobType,
    vehicleClass,
    customerHours,
    revision,
    submitting,
  ]);

  const clientFromCard =
    suggestedClient !== '' && clientPrice === suggestedClient;
  const driverFromCard =
    suggestedDriver !== '' && driverPrice === suggestedDriver;

  // The hourly total, shown as it is typed (spec 2.5.6.3). Calculated with the
  // same `billedHours` the server uses, so the quote on screen and the figure
  // that gets stored cannot disagree.
  const hoursValue = customerHours.trim() === '' ? null : Number(customerHours);
  const minimumValue = minimumHours.trim() === '' ? null : Number(minimumHours);
  const rateValue = customerRate.trim() === '' ? 0 : Number(customerRate);
  const billed = billedHours(
    Number.isFinite(hoursValue as number) ? hoursValue : null,
    Number.isFinite(minimumValue as number) ? minimumValue : null,
  );
  const hourlyTotal =
    billed !== null && Number.isFinite(rateValue) && rateValue > 0
      ? billed * rateValue
      : null;

  // Blank means "nobody has said", which is the state worth warning about. A
  // typed 0 is a deliberate statement and gets a zero-value reason instead.
  // An hourly job with a total is priced even when the fixed fare is blank.
  const priceMissing = clientPrice.trim() === '' && hourlyTotal === null;
  const needsConfirmation = priceMissing && !confirmedUnpriced;

  /** Choosing a driver defaults the vehicle, but never locks it. */
  function onDriverChange(nextDriverId: string) {
    setDriverId(nextDriverId);
    const driver = drivers.find((d) => d.id === nextDriverId);
    if (driver?.assignedVehicleId) setVehicleId(driver.assignedVehicleId);
  }

  return (
    <form
      action={formAction}
      className="max-w-4xl space-y-8"
      ref={formRef}
      onBlur={() => setRevision((current) => current + 1)}
      onSubmit={() => {
        // Synchronous, and before the transition starts.
        submitted.current = true;
        if (pendingQuote.current) clearTimeout(pendingQuote.current);
      }}
    >
      {state.error ? (
        <Alert variant="destructive" data-testid="form-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Booking
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="clientId" label="Client" errors={errors.clientId}>
            <Select
              {...fieldProps('clientId', errors.clientId)}
              defaultValue={values.clientId}
            >
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
            <Select
              {...fieldProps('accountId', errors.accountId)}
              defaultValue={values.accountId}
            >
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
          {/* Suggests as you type, and stores the postcode and coordinates
              alongside the text — spec 4.8.6. With no provider configured it
              still completes UK postcodes and offers saved locations, so it
              is never worse than the plain box it replaced. */}
          <FormField name="pickupText" label="Pickup" required errors={errors.pickupText}>
            <AddressField
              name="pickupText"
              required
              autoFocus
              invalid={Boolean(errors.pickupText?.length)}
              describedBy={
                errors.pickupText?.length ? 'pickupText-error' : undefined
              }
              defaultValue={{
                text: values.pickupText,
                postcode: values.pickupPostcode,
                lat: values.pickupLat,
                lng: values.pickupLng,
              }}
              placeholder="The Dorchester"
              onChosen={() => setRevision((count) => count + 1)}
            />
          </FormField>

          <FormField
            name="dropoffText"
            label="Destination"
            required
            errors={errors.dropoffText}
          >
            <AddressField
              name="dropoffText"
              required
              invalid={Boolean(errors.dropoffText?.length)}
              describedBy={
                errors.dropoffText?.length ? 'dropoffText-error' : undefined
              }
              defaultValue={{
                text: values.dropoffText,
                postcode: values.dropoffPostcode,
                lat: values.dropoffLat,
                lng: values.dropoffLng,
              }}
              placeholder="Heathrow Terminal 5"
              onChosen={() => setRevision((count) => count + 1)}
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
          Stops
        </h2>
        <StopsField initial={values.stops} locations={locations} />
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

          {openShifts.length > 0 ? (
            <FormField
              name="shiftId"
              label="Part of a shift"
              hint="A hired driver is paid for the shift, so this job carries no driver fee of its own."
              errors={errors.shiftId}
            >
              <Select
                {...fieldProps('shiftId', errors.shiftId)}
                defaultValue={values.shiftId}
              >
                <option value="">Not on a shift</option>
                {openShifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

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

        {/*
          Spec 4.2.7. The suggestion is stated, not silently applied: an
          operator who cannot see where a number came from has no way to
          judge whether to keep it. Overwriting either field clears its
          marker, which is what "full manual override" has to look like.
        */}
        {quote ? (
          <div
            className="flex items-start gap-2 rounded-md border border-dashed bg-background/60 p-3 text-xs"
            data-testid="rate-card-suggestion"
          >
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">From the rate card</p>
              <p className="mt-0.5 text-muted-foreground">
                {quote.explanation}
                {quote.fromZoneName || quote.toZoneName
                  ? ` · ${quote.fromZoneName ?? 'anywhere'} → ${quote.toZoneName ?? 'anywhere'}`
                  : ''}
              </p>
              {!clientFromCard ? (
                <button
                  type="button"
                  className="mt-1 font-medium underline"
                  onClick={() => {
                    const client = (quote.clientPricePence / 100).toFixed(2);
                    setClientPrice(client);
                    setSuggestedClient(client);
                    setConfirmedUnpriced(false);
                    if (quote.driverPricePence !== null) {
                      const driver = (quote.driverPricePence / 100).toFixed(2);
                      setDriverPrice(driver);
                      setSuggestedDriver(driver);
                    }
                  }}
                >
                  Use {(quote.clientPricePence / 100).toFixed(2)}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/*
          What the card suggested, carried to the server so the audit entry
          can record it next to what was actually saved — spec 4.2.8. Not the
          price itself: the server never trusts a posted total.
        */}
        {quote ? (
          <>
            <input type="hidden" name="rateCardRuleId" value={quote.rateCardRuleId} />
            {/* In pounds, like the visible price fields — the schema does
                the conversion to pence in one place. */}
            <input
              type="hidden"
              name="suggestedClientPrice"
              value={penceToField(quote.clientPricePence)}
            />
            <input
              type="hidden"
              name="suggestedDriverPrice"
              value={penceToField(quote.driverPricePence)}
            />
          </>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="clientPrice"
            label="Client price"
            hint={
              clientFromCard
                ? 'From the rate card — change it and this note goes away.'
                : isHourly
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
            hint={
              driverFromCard
                ? 'From the rate card — change it and this note goes away.'
                : 'What the driver is paid for this job.'
            }
            errors={errors.driverPricePence}
          >
            <Input
              {...fieldProps('driverPrice', errors.driverPricePence)}
              inputMode="decimal"
              placeholder="80.00"
              value={driverPrice}
              onChange={(event) => setDriverPrice(event.target.value)}
            />
          </FormField>
        </div>

        {isHourly ? (
          <div className="space-y-4 rounded-md border border-dashed p-3">
            <p className="text-sm font-medium">Priced by the hour</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                name="customerHours"
                label="Hours booked"
                errors={errors.customerHours}
              >
                <Input
                  {...fieldProps('customerHours', errors.customerHours)}
                  inputMode="decimal"
                  placeholder="4"
                  value={customerHours}
                  onChange={(event) => setCustomerHours(event.target.value)}
                />
              </FormField>
              <FormField
                name="customerRate"
                label="Hourly rate"
                errors={errors.customerRatePence}
              >
                <Input
                  {...fieldProps('customerRate', errors.customerRatePence)}
                  inputMode="decimal"
                  placeholder="45.00"
                  value={customerRate}
                  onChange={(event) => setCustomerRate(event.target.value)}
                />
              </FormField>
              <FormField
                name="minimumHours"
                label="Minimum hours"
                hint="Billed hours are the greater of the two."
                errors={errors.minimumHours}
              >
                <Input
                  {...fieldProps('minimumHours', errors.minimumHours)}
                  inputMode="decimal"
                  placeholder="4"
                  value={minimumHours}
                  onChange={(event) => setMinimumHours(event.target.value)}
                />
              </FormField>
            </div>
            {hourlyTotal !== null ? (
              <p className="text-sm" data-testid="hourly-total">
                <span className="text-muted-foreground">
                  {billed} billed hours ×{' '}
                  {Number(customerRate).toFixed(2)} ={' '}
                </span>
                <span className="font-semibold tabular">
                  £{hourlyTotal.toFixed(2)}
                </span>
                {billed !== hoursValue ? (
                  <span className="ml-1 text-muted-foreground">
                    (minimum applied)
                  </span>
                ) : null}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Waiting time and stop charges are additional to this, never
              folded into it.
            </p>
          </div>
        ) : null}

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
