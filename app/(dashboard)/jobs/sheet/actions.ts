'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { assignSender, createSender, discardSheet } from '@/lib/job-sheets/store';
import { actingUser } from '@/lib/request-context';

/**
 * Teaching the install a sender, and setting a sheet aside.
 *
 * Both are small, and both are the operator making a judgement the system
 * cannot: who is billed for this agency's work, and whether a sheet it has
 * already seen is a duplicate or a genuine second journey.
 */

/**
 * Record a new agency and read the sheet again with their labels.
 *
 * Re-reading is what makes teaching retrospective rather than only helping the
 * next sheet: the one in front of the operator is the one that benefits.
 */
export async function createSenderAction(
  sheetId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { user } = await actingUser('editJobs');

    const sender = await createSender({
      name: String(formData.get('name') ?? '').trim(),
      fingerprint: String(formData.get('fingerprint') ?? ''),
      accountId: emptyToNull(formData.get('accountId')),
      clientId: emptyToNull(formData.get('clientId')),
      createdById: user.id,
    });

    await assignSender(sheetId, sender.id);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  revalidatePath(`/jobs/sheet/${sheetId}`);
  redirect(`/jobs/new?sheet=${sheetId}`);
}

/** Attach a sheet to an agency already known, and re-read it. */
export async function assignSenderAction(
  sheetId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await actingUser('editJobs');

    const senderId = String(formData.get('senderId') ?? '').trim();
    if (!senderId) {
      return { error: 'Choose which agency sent this sheet.' };
    }

    await assignSender(sheetId, senderId);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  revalidatePath(`/jobs/sheet/${sheetId}`);
  redirect(`/jobs/new?sheet=${sheetId}`);
}

/**
 * Set a sheet aside without booking it.
 *
 * For the duplicate an agency resent, and for a sheet that turned out to be a
 * cancellation. The row stays — a sheet that was read and deliberately not
 * booked is worth being able to see later, and deleting it would mean the next
 * copy of the same file looks new again.
 */
export async function discardSheetAction(
  sheetId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    await actingUser('editJobs');
    await discardSheet(sheetId);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  revalidatePath('/jobs');
  redirect('/jobs/sheet');
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}
