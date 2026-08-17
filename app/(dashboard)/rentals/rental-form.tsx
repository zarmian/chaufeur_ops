'use client';

import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SubmitButton } from '@/components/submit-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import { RATE_TYPE_LABELS } from '@/lib/rentals';

/**
 * What the contract-terms fields start from.
 *
 * Money arrives already formatted for a text input ("2500.00") rather than as
 * pence, because that is what a person types and what the server parses back.
 */
export interface ContractDefaults {
  mileageAllowancePerDay: number | null;
  minimumTermDays: number | null;
  depositReturnDays: number | null;
  excessMileage: string | null;
  insuranceExcess: string | null;
  congestionCharge: string | null;
  smokingCharge: string | null;
  panelRepair: string | null;
  wheelScratch: string | null;
  ownerSignatory: string | null;
}

/**
 * A hire as the form holds it.
 *
 * Every field is a string, because that is what an input carries and what the
 * schema parses back. Money arrives formatted for typing ("80.00"), not as
 * pence.
 */
export interface RentalFormValues {
  vehicleId: string;
  renterType: 'DRIVER' | 'ACCOUNT' | 'EXTERNAL';
  driverId: string;
  accountId: string;
  hirerName: string;
  hirerAddress: string;
  hirerPhone: string;
  hirerLicenceNumber: string;
  startAt: string;
  endAt: string;
  rateType: string;
  rate: string;
  deposit: string;
  mileageOut: string;
  fuelOutPct: string;
  advancePayment: string;
  notes: string;
}

const BLANK: RentalFormValues = {
  vehicleId: '',
  renterType: 'DRIVER',
  driverId: '',
  accountId: '',
  hirerName: '',
  hirerAddress: '',
  hirerPhone: '',
  hirerLicenceNumber: '',
  startAt: '',
  endAt: '',
  rateType: 'DAILY',
  rate: '',
  deposit: '',
  mileageOut: '',
  fuelOutPct: '',
  advancePayment: '',
  notes: '',
};

/**
 * Booking a car out, and correcting one already booked.
 *
 * The mileage and fuel readings are on the booking form rather than a
 * separate handover screen, because they are taken at the moment the keys
 * change hands — asking for them later means they get guessed.
 *
 * The same form edits an existing hire. What it does not touch is the return:
 * the mileage and damage recorded when the car came back belong to the
 * book-it-back-in form, where somebody stood at the car and wrote them down.
 */
export function RentalForm({
  action,
  vehicles,
  drivers,
  accounts,
  defaults,
  values = BLANK,
  submitLabel = 'Book the car out',
  /**
   * Offer to save a one-off hirer as an account. Booking only: an edit does
   * not create accounts, so showing the tick there would be a control that
   * does nothing.
   */
  offerToSaveHirer = true,
  cancelHref,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  vehicles: Array<{ id: string; label: string }>;
  drivers: Array<{ id: string; label: string }>;
  accounts: Array<{ id: string; label: string }>;
  /** Contract terms the form starts from; every one is editable per hire. */
  defaults: ContractDefaults;
  /** An existing hire, when editing. Blank for a new one. */
  values?: RentalFormValues;
  submitLabel?: string;
  offerToSaveHirer?: boolean;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};
  const [renterType, setRenterType] = useState<'DRIVER' | 'ACCOUNT' | 'EXTERNAL'>(
    values.renterType,
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
          The hire
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="vehicleId" label="Vehicle" required errors={errors.vehicleId}>
            <Select
              {...fieldProps('vehicleId', errors.vehicleId)}
              defaultValue={values.vehicleId}
              required
            >
              <option value="">Choose a vehicle</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField name="renterType" label="Renting to" required>
            <Select
              {...fieldProps('renterType')}
              value={renterType}
              onChange={(event) =>
                setRenterType(event.target.value as 'DRIVER' | 'ACCOUNT' | 'EXTERNAL')
              }
            >
              <option value="DRIVER">A driver on the fleet</option>
              <option value="ACCOUNT">A company with an account</option>
              <option value="EXTERNAL">Someone not on the system</option>
            </Select>
          </FormField>

          {renterType === 'DRIVER' ? (
            <FormField name="driverId" label="Driver" required errors={errors.driverId}>
              <Select
                {...fieldProps('driverId', errors.driverId)}
                defaultValue={values.driverId}
                required
              >
                <option value="">Choose a driver</option>
                {drivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {renterType === 'ACCOUNT' ? (
            <FormField name="accountId" label="Company" required errors={errors.accountId}>
              <Select
                {...fieldProps('accountId', errors.accountId)}
                defaultValue={values.accountId}
                required
              >
                <option value="">Choose an account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          <FormField name="startAt" label="Goes out" required errors={errors.startAt}>
            <Input
              {...fieldProps('startAt', errors.startAt)}
              type="datetime-local"
              defaultValue={values.startAt}
              required
            />
          </FormField>

          <FormField name="endAt" label="Due back" required errors={errors.endAt}>
            <Input
              {...fieldProps('endAt', errors.endAt)}
              type="datetime-local"
              defaultValue={values.endAt}
              required
            />
          </FormField>

          <FormField name="rateType" label="Charged" errors={errors.rateType}>
            <Select
              {...fieldProps('rateType', errors.rateType)}
              defaultValue={values.rateType}
            >
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
              defaultValue={values.rate}
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
              defaultValue={values.deposit}
            />
          </FormField>
        </div>
      </section>

      {/* The hirer's own details. Shown for a company hire too: the licence
          belongs to whoever actually drives it, and the contract names them. */}
      {renterType !== 'DRIVER' ? (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Hirer, as the contract states them
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {renterType === 'EXTERNAL' ? (
              <FormField name="hirerName" label="Hirer name" required errors={errors.hirerName}>
                <Input
                  {...fieldProps('hirerName', errors.hirerName)}
                  defaultValue={values.hirerName}
                  required
                />
              </FormField>
            ) : null}
            <FormField name="hirerPhone" label="Contact number" errors={errors.hirerPhone}>
              <Input
                {...fieldProps('hirerPhone', errors.hirerPhone)}
                type="tel"
                defaultValue={values.hirerPhone}
              />
            </FormField>
            <FormField name="hirerAddress" label="Address" errors={errors.hirerAddress}>
              <Textarea
                {...fieldProps('hirerAddress', errors.hirerAddress)}
                rows={2}
                defaultValue={values.hirerAddress}
              />
            </FormField>
            <FormField
              name="hirerLicenceNumber"
              label="Driving licence number"
              errors={errors.hirerLicenceNumber}
            >
              <Input
                {...fieldProps('hirerLicenceNumber', errors.hirerLicenceNumber)}
                defaultValue={values.hirerLicenceNumber}
              />
            </FormField>
          </div>
          {renterType === 'EXTERNAL' && offerToSaveHirer ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="saveHirerAsAccount" value="true" defaultChecked />
              Save them as an account, so a repeat hire is picked from the list
            </label>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Contract terms
        </h2>
        <p className="text-sm text-muted-foreground">
          What the hire agreement will say. Pre-filled from the last hire and
          editable per contract — anything left blank prints as a line to write
          on, not as zero.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="mileageAllowancePerDay" label="Daily mileage allowance" errors={errors.mileageAllowancePerDay}>
            <Input {...fieldProps('mileageAllowancePerDay', errors.mileageAllowancePerDay)}
              type="number" min={0} defaultValue={defaults.mileageAllowancePerDay ?? ''} placeholder="175" />
          </FormField>
          <FormField name="excessMileagePence" label="Excess mileage, per mile" errors={errors.excessMileagePence}>
            <Input {...fieldProps('excessMileagePence', errors.excessMileagePence)}
              inputMode="decimal" defaultValue={defaults.excessMileage ?? ''} placeholder="1.50" />
          </FormField>
          <FormField name="advancePaymentPence" label="Total advance payment" errors={errors.advancePaymentPence}>
            <Input {...fieldProps('advancePaymentPence', errors.advancePaymentPence)}
              inputMode="decimal" defaultValue={values.advancePayment} placeholder="400.00" />
          </FormField>
          <FormField name="minimumTermDays" label="Minimum term (days)" errors={errors.minimumTermDays}>
            <Input {...fieldProps('minimumTermDays', errors.minimumTermDays)}
              type="number" min={0} defaultValue={defaults.minimumTermDays ?? ''} />
          </FormField>
          <FormField name="insuranceExcessPence" label="Insurance excess" errors={errors.insuranceExcessPence}>
            <Input {...fieldProps('insuranceExcessPence', errors.insuranceExcessPence)}
              inputMode="decimal" defaultValue={defaults.insuranceExcess ?? ''} placeholder="2500.00" />
          </FormField>
          <FormField name="congestionChargePence" label="Congestion charge, per day" errors={errors.congestionChargePence}>
            <Input {...fieldProps('congestionChargePence', errors.congestionChargePence)}
              inputMode="decimal" defaultValue={defaults.congestionCharge ?? ''} placeholder="15.00" />
          </FormField>
          <FormField name="smokingChargePence" label="Smoking or vaping charge" errors={errors.smokingChargePence}>
            <Input {...fieldProps('smokingChargePence', errors.smokingChargePence)}
              inputMode="decimal" defaultValue={defaults.smokingCharge ?? ''} placeholder="300.00" />
          </FormField>
          <FormField name="panelRepairPence" label="Scratch, per panel" errors={errors.panelRepairPence}>
            <Input {...fieldProps('panelRepairPence', errors.panelRepairPence)}
              inputMode="decimal" defaultValue={defaults.panelRepair ?? ''} placeholder="150.00" />
          </FormField>
          <FormField name="wheelScratchPence" label="Wheel scratch" errors={errors.wheelScratchPence}>
            <Input {...fieldProps('wheelScratchPence', errors.wheelScratchPence)}
              inputMode="decimal" defaultValue={defaults.wheelScratch ?? ''} placeholder="100.00" />
          </FormField>
          <FormField name="depositReturnDays" label="Deposit returned after (days)" errors={errors.depositReturnDays}>
            <Input {...fieldProps('depositReturnDays', errors.depositReturnDays)}
              type="number" min={0} defaultValue={defaults.depositReturnDays ?? ''} placeholder="10" />
          </FormField>
          <FormField name="ownerSignatory" label="Signing for the company" errors={errors.ownerSignatory}>
            <Input {...fieldProps('ownerSignatory', errors.ownerSignatory)}
              defaultValue={defaults.ownerSignatory ?? ''} placeholder="Name and role" />
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
              defaultValue={values.mileageOut}
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
              defaultValue={values.fuelOutPct}
            />
          </FormField>
        </div>
        <p className="text-sm text-muted-foreground">
          The handover checklist is created with the rental. Work through it
          with the driver at the car.
        </p>
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


