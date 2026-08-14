import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { changePasswordAction } from '../settings/users/actions';
import { ChangePasswordForm } from './change-password-form';

export const metadata = { title: 'Change password' };

/**
 * Any signed-in user, including a VIEWER — guarded by the weakest capability
 * every role holds, because somebody handed a temporary password has to be
 * able to replace it whatever their role.
 */
export default async function ChangePasswordPage() {
  const user = await pageRequireCapability('viewJobs');

  return (
    <>
      <PageHeader
        title={user.mustChangePassword ? 'Choose your password' : 'Change your password'}
        description={
          user.mustChangePassword
            ? 'You are signed in with a temporary password that somebody else has seen. Choose your own to carry on.'
            : 'Your other sessions will be signed out. This one stays open.'
        }
      />
      <ChangePasswordForm action={changePasswordAction} />
    </>
  );
}
