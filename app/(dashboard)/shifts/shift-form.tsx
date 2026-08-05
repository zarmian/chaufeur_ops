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

/**
 * Clocking a hired driver on.
 *
 * The rate field is optional: left blank it comes from the driver's
 * engagement at that date, which is the normal case. It is offered at all for
 * the shift worked on unusual terms — otherwise the only way to record one
 * would be to edit the engagement, which would silently change other shifts.
 */
export function ShiftForm({
  action,
  drivers,
  vehicles,
  cancelHref,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  drivers: Array<{ id: string; label: string }>;
  vehicles: Array<{ id: string; label: string }>;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fields ?? {};

  return (
    <form action={formAction} className="max-w-2xl space-y-6">
      {state.error ? (
        <Alert variant="destructive" data-testid="form-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="driverId" label="Driver" required errors={errors.driverId}>
          <Select {...fieldProps('driverId', errors.driverId)} required>
            <option value="">Choose a driver</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.label}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField name="vehicleId" label="Vehicle" errors={errors.vehicleId}>
          <Select {...fieldProps('vehicleId', errors.vehicleId)}>
            <option value="">Not recorded</option>
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.label}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField name="startedAt" label="Clocked on" required errors={errors.startedAt}>
          <Input
            {...fieldProps('startedAt', errors.startedAt)}
            type="datetime-local"
            required
          />
        </FormField>

        <FormField
          name="breakMinutes"
          label="Unpaid break (minutes)"
          errors={errors.breakMinutes}
        >
          <Input
            {...fieldProps('breakMinutes', errors.breakMinutes)}
            type="number"
            min={0}
            defaultValue={0}
          />
        </FormField>

        <FormField
          name="hourlyRatePence"
          label="Hourly rate (pence)"
          hint="Leave blank to use the driver's engagement rate for that date."
          errors={errors.hourlyRatePence}
        >
          <Input
            {...fieldProps('hourlyRatePence', errors.hourlyRatePence)}
            type="number"
            min={0}
            placeholder="1800"
          />
        </FormField>
      </div>

      <FormField name="notes" label="Notes" errors={errors.notes}>
        <Textarea {...fieldProps('notes', errors.notes)} rows={2} />
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
      {pending ? 'Starting…' : 'Start the shift'}
    </Button>
  );
}

/**
 * Clocking off.
 *
 * A plain post to a route handler, not a Server Action — see the note in
 * `app/api/shifts/[id]/actions/route.ts`. This decides what a driver is paid,
 * so a submission that silently does not land is not acceptable.
 */
export function CloseShiftForm({
  shiftId,
  defaultBreakMinutes,
  error,
}: {
  shiftId: string;
  defaultBreakMinutes: number;
  error?: string | null;
}) {
  const errors: Record<string, string[]> = {};

  return (
    <form
      method="post"
      action={`/api/shifts/${shiftId}/actions`}
      className="space-y-4"
    >
      <input type="hidden" name="intent" value="close" />
      {error ? (
        <Alert variant="destructive" data-testid="close-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="endedAt" label="Clocked off" required errors={errors.endedAt}>
          <Input
            {...fieldProps('endedAt', errors.endedAt)}
            type="datetime-local"
            required
          />
        </FormField>
        <FormField
          name="breakMinutes"
          label="Unpaid break (minutes)"
          errors={errors.breakMinutes}
        >
          <Input
            {...fieldProps('breakMinutes', errors.breakMinutes)}
            type="number"
            min={0}
            defaultValue={defaultBreakMinutes}
          />
        </FormField>
      </div>

      <Button type="submit">End the shift</Button>
    </form>
  );
}
