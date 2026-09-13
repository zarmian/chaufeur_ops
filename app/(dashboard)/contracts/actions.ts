'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  cancelContractJobsFrom,
  contractSchema,
  createContract,
  endedAfter,
  generateContractJobs,
  reassignContractJobs,
  repriceContractJobs,
  setContractActive,
  updateContract,
  type CancelResult,
  type ReassignResult,
} from '@/lib/contracts';
import { fromDateOnlyString } from '@/lib/dates';
import type { RepriceScope } from '@/lib/enum-options';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { getLocaleConfig } from '@/lib/locale-store';
import { actingUser } from '@/lib/request-context';

/**
 * The form's fields, in one place.
 *
 * Shared by create and edit so the two cannot drift — a field wired into only
 * one of them saves on a new contract and silently does nothing on an
 * existing one.
 */
function readContractForm(formData: FormData) {
  return {
    label: formData.get('label') ?? '',
    clientId: formData.get('clientId') ?? '',
    accountId: formData.get('accountId') ?? '',
    pickupText: formData.get('pickupText') ?? '',
    dropoffText: formData.get('dropoffText') ?? '',
    viaText: formData.get('viaText') ?? '',
    pickupPostcode: formData.get('pickupPostcode') ?? '',
    dropoffPostcode: formData.get('dropoffPostcode') ?? '',
    startTime: formData.get('startTime') ?? '',
    estimatedMinutes: formData.get('estimatedMinutes') ?? '',
    passengerName: formData.get('passengerName') ?? '',
    passengerPhone: formData.get('passengerPhone') ?? '',
    driverId: formData.get('driverId') ?? '',
    vehicleId: formData.get('vehicleId') ?? '',
    // An unticked box posts nothing, so an empty list means every day — which
    // is what the form says it means.
    weekdays: formData.getAll('weekdays').map((value) => Number(value)),
    startsOn: formData.get('startsOn') ?? '',
    endsOn: formData.get('endsOn') ?? '',
    dayRatePence: formData.get('dayRate') ?? '',
    driverDayRatePence: formData.get('driverDayRate') ?? '',
    vatTreatment: formData.get('vatTreatment') ?? '',
    generateAheadDays: formData.get('generateAheadDays') ?? '14',
    notes: formData.get('notes') ?? '',
  };
}

export async function createContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editJobs');
    const parsed = contractSchema.parse(readContractForm(formData));
    const created = await createContract(parsed, audit);
    id = created.id;

    // Book the first days now rather than leaving the contract looking empty
    // until the cron runs overnight. An operator who sets one up expects to
    // see it on the board.
    const { timeZone } = await getLocaleConfig();
    await generateContractJobs(id, audit, { timeZone });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/contracts');
  revalidatePath('/jobs');
  redirect(`/contracts/${id}`);
}

/**
 * What was moved, and what was not — in one line an operator can act on.
 *
 * The days left behind are the whole reason this is said out loud rather than
 * counted. A car refused for a lapsed MOT and a day somebody put another car
 * on are both "not moved", and both need a person to decide something.
 */
function describe(result: ReassignResult): string {
  const parts = [
    `${result.moved} upcoming ${result.moved === 1 ? 'day' : 'days'} moved`,
  ];

  if (result.skipped.length > 0) {
    parts.push(
      `${result.skipped.length} left as ${result.skipped.length === 1 ? 'it was' : 'they were'}: ${result.skipped
        .slice(0, 5)
        .map((skip) => `${skip.reference} — ${skip.reason}`)
        .join('; ')}${result.skipped.length > 5 ? '…' : ''}`,
    );
  }

  return parts.join('. ');
}

/**
 * What was called off, and what would not go — in one line.
 *
 * The refusals are the part that needs saying. An invoiced day cannot be
 * cancelled while the client is holding a document that bills for it, and an
 * office that assumed the whole contract was called off would leave a car
 * going to a booking nobody expects to pay for.
 */
function describeCancelled(result: CancelResult): string {
  const parts = [
    `${result.cancelled} upcoming ${result.cancelled === 1 ? 'day' : 'days'} cancelled`,
  ];

  if (result.refused.length > 0) {
    parts.push(
      `${result.refused.length} could not be: ${result.refused
        .slice(0, 5)
        .map((refusal) => `${refusal.reference} — ${refusal.reason}`)
        .join('; ')}${result.refused.length > 5 ? '…' : ''}`,
    );
  }

  return parts.join('. ');
}

/** Only the three the form offers; anything else means "leave them alone". */
function repriceScopeFrom(value: FormDataEntryValue | null): RepriceScope {
  const text = String(value ?? '');
  return text === 'upcoming' || text === 'all' ? text : 'none';
}

export async function updateContractAction(
  contractId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const query = new URLSearchParams();

  try {
    const { audit } = await actingUser('editJobs');
    const parsed = contractSchema.parse(readContractForm(formData));
    const { previous } = await updateContract(contractId, parsed, audit);

    /*
     * An end date brought forward calls off the days beyond it.
     *
     * Before the move below, deliberately: a day that is about to be cancelled
     * should not first send its driver a message about a change of car.
     *
     * Not offered as a choice, because there is no sensible other answer. A
     * contract that ends on the 20th has no business putting a car outside
     * somebody's house on the 25th, and leaving those days standing is how an
     * office ends an arrangement, believes it is done, and sends a driver
     * anyway.
     */
    const { timeZone } = await getLocaleConfig();
    const endedFrom = endedAfter(
      previous.endsOn,
      parsed.endsOn ? fromDateOnlyString(parsed.endsOn) : null,
      timeZone,
    );
    if (endedFrom) {
      const result = await cancelContractJobsFrom(contractId, endedFrom, audit);
      if (result.cancelled > 0 || result.refused.length > 0) {
        query.set('contractEnded', describeCancelled(result));
        revalidatePath('/jobs');
        revalidatePath('/dispatch');
      }
    }

    /*
     * Moving the days not yet started onto the new driver or car.
     *
     * Unlike the reprice below, this is on unless the operator turns it off.
     * A contract's car changing is a change to the arrangement itself — the
     * days it has already booked against the old one are the point of the
     * question, not an afterthought — and leaving them behind means a client
     * watching for a registration that is not coming.
     */
    if (formData.get('moveUpcoming') !== null) {
      const result = await reassignContractJobs(contractId, previous, audit);
      if (result.moved > 0 || result.skipped.length > 0) {
        query.set('contractMoved', describe(result));
        revalidatePath('/jobs');
        revalidatePath('/dispatch');
      }
    }

    // Reaching back into days already booked, when the operator asked for it.
    // Off by default — see `repriceContractJobs`.
    const scope = repriceScopeFrom(formData.get('repriceScope'));
    if (scope !== 'none') {
      const result = await repriceContractJobs(contractId, scope, audit);

      // Said out loud rather than left to be noticed. An invoiced day cannot
      // be repriced, and an operator who assumed everything moved would bill
      // the difference and wonder why it did not reconcile.
      const parts = [
        `${result.repriced} ${result.repriced === 1 ? 'day' : 'days'} repriced`,
      ];
      if (result.skipped.length > 0) {
        parts.push(
          `${result.skipped.length} left alone: ${result.skipped
            .slice(0, 5)
            .map((skip) => `${skip.reference} ${skip.reason}`)
            .join(', ')}${result.skipped.length > 5 ? '…' : ''}. Credit those invoices to change them.`,
        );
      }
      query.set('contractNotice', parts.join('. '));
      revalidatePath('/jobs');
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/contracts');
  revalidatePath(`/contracts/${contractId}`);
  const search = query.toString();
  redirect(`/contracts/${contractId}${search ? `?${search}` : ''}`);
}

/**
 * Stop or restart a contract.
 *
 * Stopping makes no more days *and* calls off the ones already booked — see
 * `setContractActive`. What was cancelled, and anything that could not be,
 * comes back on the contract screen rather than being left to be noticed on
 * the board.
 */
export async function setContractActiveAction(
  contractId: string,
  active: boolean,
): Promise<void> {
  const { audit } = await actingUser('editJobs');
  const result = await setContractActive(contractId, active, audit);

  revalidatePath('/contracts');
  revalidatePath(`/contracts/${contractId}`);

  if (result.cancelled === 0 && result.refused.length === 0) {
    revalidatePath(`/contracts/${contractId}`);
    return;
  }

  // Days came off the board, so the screens that show them are stale.
  revalidatePath('/jobs');
  revalidatePath('/dispatch');

  const query = new URLSearchParams({ contractEnded: describeCancelled(result) });
  redirect(`/contracts/${contractId}?${query.toString()}`);
}

/** Book the days now, without waiting for the overnight run. */
export async function generateNowAction(contractId: string): Promise<void> {
  const { audit } = await actingUser('editJobs');
  const { timeZone } = await getLocaleConfig();
  await generateContractJobs(contractId, audit, { timeZone });
  revalidatePath('/contracts');
  revalidatePath(`/contracts/${contractId}`);
  revalidatePath('/jobs');
}
