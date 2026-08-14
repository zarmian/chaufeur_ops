import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { createUserAction } from '../actions';
import { UserForm } from '../user-form';

export const metadata = { title: 'Add user' };

export default async function NewUserPage() {
  await pageRequireCapability('manageUsers');

  return (
    <>
      <PageHeader
        title="Add user"
        description="They will be given a temporary password, shown once on the next screen. They choose their own the first time they sign in."
      />
      <UserForm action={createUserAction} submitLabel="Create user" />
    </>
  );
}
