'use client';

import { AlertCircle } from 'lucide-react';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PAY_METHODS } from '@/lib/enum-options';

/**
 * Booking the car back in, with the readings taken at the car.
 *
 * A plain post to a route handler, not a Server Action — see the note in
 * `app/api/rentals/[id]/actions/route.ts`. The outcome comes back in the
 * query string.
 */
export function ReturnForm({ rentalId, error }: { rentalId: string; error?: string | null }) {
  const errors: Record<string, string[]> = {};

  return (
    <form
      method="post"
      action={`/api/rentals/${rentalId}/actions`}
      className="space-y-4"
    >
      <input type="hidden" name="intent" value="return" />
      {error ? (
        <Alert variant="destructive" data-testid="return-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField name="returnedAt" label="Came back" required errors={errors.returnedAt}>
          <Input
            {...fieldProps('returnedAt', errors.returnedAt)}
            type="datetime-local"
            required
          />
        </FormField>
        <FormField name="mileageIn" label="Mileage" errors={errors.mileageIn}>
          <Input {...fieldProps('mileageIn', errors.mileageIn)} type="number" min={0} />
        </FormField>
        <FormField name="fuelInPct" label="Fuel (%)" errors={errors.fuelInPct}>
          <Input
            {...fieldProps('fuelInPct', errors.fuelInPct)}
            type="number"
            min={0}
            max={100}
          />
        </FormField>
      </div>

      <FormField
        name="damageNotes"
        label="Damage found"
        hint="Leave blank if the car came back as it went out."
        errors={errors.damageNotes}
      >
        <Textarea {...fieldProps('damageNotes', errors.damageNotes)} rows={2} />
      </FormField>

      <FormField
        name="damageCharge"
        label="Damage charge"
        hint="Added on top of the hire, never folded into the rate."
        errors={errors.damageChargePence}
      >
        <Input
          {...fieldProps('damageCharge', errors.damageChargePence)}
          inputMode="decimal"
          placeholder="0.00"
          className="max-w-40"
        />
      </FormField>

      <Button type="submit">Book it back in</Button>
    </form>
  );
}

/**
 * Money received against the hire.
 *
 * A plain post. A payment that appears not to have been recorded is the worst
 * version of the lost-submission bug — someone takes the money twice.
 */
export function PaymentForm({ rentalId }: { rentalId: string }) {
  const errors: Record<string, string[]> = {};

  return (
    <form
      method="post"
      action={`/api/rentals/${rentalId}/actions`}
      className="space-y-3"
    >
      <input type="hidden" name="intent" value="payment" />

      <FormField name="amount" label="Amount" required errors={errors.amount}>
        <Input
          {...fieldProps('amount', errors.amount)}
          inputMode="decimal"
          placeholder="80.00"
          required
        />
      </FormField>

      <FormField name="paidAt" label="Received" errors={errors.paidAt}>
        <Input {...fieldProps('paidAt', errors.paidAt)} type="date" />
      </FormField>

      <FormField name="method" label="Method" errors={errors.method}>
        <Select {...fieldProps('method', errors.method)}>
          <option value="">Not recorded</option>
          {PAY_METHODS.map((method) => (
            <option key={method.value} value={method.value}>
              {method.label}
            </option>
          ))}
        </Select>
      </FormField>

      <Button type="submit" className="w-full">
        Record payment
      </Button>
    </form>
  );
}
