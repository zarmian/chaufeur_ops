'use client';

import { AlertCircle } from 'lucide-react';
import { useActionState, useState } from 'react';
import { FilteredSelect } from '@/components/filtered-select';
import { FormField, fieldProps } from '@/components/form-field';
import { SubmitButton } from '@/components/submit-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';

/**
 * Whose sheet is this?
 *
 * Asked once per agency, and only because nothing else can answer it. The
 * reader can tell what the sheet says; it cannot know which of the accounts on
 * this install gets the invoice, and a job booked without one can never be
 * billed — which is the whole reason an agency's sheet is worth reading.
 *
 * Two routes through it, because both happen. Usually the agency already
 * exists as an account and this is simply the first sheet they have sent, so
 * picking them is one field. Occasionally they are new, and then the account
 * has to exist first — said plainly rather than offering a text box that
 * quietly creates a half-formed one.
 */

interface Option {
  id: string;
  label: string;
}

export function SenderForm({
  createAction,
  assignAction,
  senders,
  accounts,
  clients,
  suggestedName,
}: {
  createAction: (state: FormState, formData: FormData) => Promise<FormState>;
  assignAction: (state: FormState, formData: FormData) => Promise<FormState>;
  senders: Option[];
  accounts: Option[];
  clients: Option[];
  /**
   * A name taken from the sheet's own letterhead, if one could be found.
   *
   * A suggestion in a box somebody checks, never a decision. It is also the
   * fingerprint, so getting it wrong matters: too loose and it would claim
   * another agency's sheets.
   */
  suggestedName: string;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>(
    senders.length > 0 ? 'existing' : 'new',
  );
  const [createState, create] = useActionState(createAction, INITIAL_FORM_STATE);
  const [assignState, assign] = useActionState(assignAction, INITIAL_FORM_STATE);

  const state = mode === 'new' ? createState : assignState;

  return (
    <div className="space-y-5">
      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {senders.length > 0 ? (
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="sender-mode"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
            />
            An agency already set up
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="sender-mode"
              checked={mode === 'new'}
              onChange={() => setMode('new')}
            />
            A new one
          </label>
        </div>
      ) : null}

      {mode === 'existing' ? (
        <form action={assign} className="space-y-4">
          <FormField
            name="senderId"
            label="Agency"
            required
            hint="Their sheets will be recognised from now on."
          >
            <FilteredSelect
              {...fieldProps('senderId')}
              options={senders.map((sender) => ({
                value: sender.id,
                label: sender.label,
              }))}
              emptyLabel="Choose an agency"
              searchLabel="Search agencies"
            />
          </FormField>

          <SubmitButton label="Use this agency" />
        </form>
      ) : (
        <form action={create} className="space-y-4">
          <FormField
            name="name"
            label="Agency name"
            required
            hint="As you want it shown."
          >
            <Input {...fieldProps('name')} defaultValue={suggestedName} required />
          </FormField>

          <FormField
            name="fingerprint"
            label="Text that identifies their sheets"
            required
            hint="Their trading name as printed on the page. Distinctive enough that no other agency's sheet contains it — recognising the wrong sender bills the wrong company."
          >
            <Input
              {...fieldProps('fingerprint')}
              defaultValue={suggestedName}
              required
              minLength={4}
            />
          </FormField>

          <FormField
            name="accountId"
            label="Who is invoiced"
            hint="The agency, not the passenger — they placed the booking and they pay. Leave empty only if you will set it on each job."
          >
            <FilteredSelect
              {...fieldProps('accountId')}
              options={accounts.map((account) => ({
                value: account.id,
                label: account.label,
              }))}
              emptyLabel="No account"
              searchLabel="Search accounts"
            />
          </FormField>

          <FormField
            name="clientId"
            label="Always for this client"
            hint="Only where every job they send is for the same end client. Usually left empty."
          >
            <FilteredSelect
              {...fieldProps('clientId')}
              options={clients.map((client) => ({
                value: client.id,
                label: client.label,
              }))}
              emptyLabel="No client"
              searchLabel="Search clients"
            />
          </FormField>

          <SubmitButton label="Save and read again" />
        </form>
      )}
    </div>
  );
}
