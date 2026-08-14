'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { actingUser } from '@/lib/request-context';
import {
  changeOwnPassword,
  createUser,
  resetPassword,
  setUserActive,
  updateUser,
  userSchema,
} from '@/lib/users';

/**
 * Managing staff logins.
 *
 * A temporary password is shown once, on the screen that created it, and
 * never again — so it rides back in the form state rather than being stored
 * anywhere. If the administrator loses it before handing it over, they issue
 * another; that is cheaper than a system that can reveal a password twice.
 */

export interface UserFormState extends FormState {
  /** Shown once, immediately after creating a user or resetting a password. */
  temporaryPassword?: string;
  userEmail?: string;
}

function readForm(formData: FormData) {
  return {
    name: formData.get('name') ?? '',
    email: formData.get('email') ?? '',
    role: formData.get('role') ?? 'VIEWER',
  };
}

export async function createUserAction(
  _previous: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  try {
    const { audit } = await actingUser('manageUsers');
    const input = userSchema.parse(readForm(formData));
    const result = await createUser(input, audit);
    if (!result.ok) return { error: result.reason };

    revalidatePath('/settings/users');
    return {
      error: null,
      ok: true,
      temporaryPassword: result.value.temporaryPassword,
      userEmail: input.email,
    };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
}

export async function updateUserAction(
  userId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { user, audit } = await actingUser('manageUsers');
    const result = await updateUser(
      userId,
      userSchema.parse(readForm(formData)),
      user.id,
      audit,
    );
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/settings/users');
  redirect('/settings/users?updated=1');
}

export async function resetPasswordAction(
  userId: string,
  _previous: UserFormState,
  _formData: FormData,
): Promise<UserFormState> {
  try {
    const { audit } = await actingUser('manageUsers');
    const result = await resetPassword(userId, audit);
    if (!result.ok) return { error: result.reason };

    revalidatePath('/settings/users');
    return { error: null, ok: true, temporaryPassword: result.value.temporaryPassword };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
}

export async function setUserActiveAction(
  userId: string,
  active: boolean,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const { user, audit } = await actingUser('manageUsers');
    const result = await setUserActive(userId, active, user.id, audit);
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/settings/users');
  return { error: null, ok: true };
}

/**
 * Anyone changing their own password.
 *
 * Guarded by nothing beyond being signed in — `viewJobs` is the weakest
 * capability every role holds, and a VIEWER must be able to replace the
 * temporary password they were given.
 */
export async function changePasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { user, audit } = await actingUser('viewJobs');
    const password = String(formData.get('password') ?? '');
    const confirm = String(formData.get('confirm') ?? '');
    if (password !== confirm) return { error: 'Those two passwords do not match' };

    const result = await changeOwnPassword(user.id, password, audit);
    if (!result.ok) return { error: result.reason };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  redirect('/?passwordChanged=1');
}
